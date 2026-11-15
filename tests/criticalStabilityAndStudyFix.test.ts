import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config/index.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { OpportunityWindowTracker } from '../src/study/windowTracker.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import { SolanaWsProvider } from '../src/providers/solanaWs.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ArbitrageCandidate, PermanentRouteRecord, WindowClosureReason } from '../src/types/index.js';

describe('SOLANABOT — Critical Stability and Study Fix Suite', () => {
  const config = loadConfig({
    SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws'
  });

  // TASK 1 & 4: WS Flapping & Lifetime Diagnostics
  it('SolanaWs maintains cumulative session reconnection counters and never resets to 0', () => {
    const ws = new SolanaWsProvider(config);
    const initialStats = ws.getStats();
    expect(initialStats.sessionTotalDisconnects).toBe(0);
    expect(initialStats.sessionTotalReconnectAttempts).toBe(0);

    // Simulate disconnect (schedules reconnect and increments attempts)
    (ws as any).handleDisconnect((ws as any).socketGeneration, 'Heartbeat timeout [1006]', 1006, false);
    const statsAfterDrop = ws.getStats();
    expect(statsAfterDrop.sessionTotalDisconnects).toBe(1);
    expect(statsAfterDrop.sessionTotalReconnectAttempts).toBe(1);
    expect(statsAfterDrop.lastDisconnectCode).toBe(1006);
    expect(statsAfterDrop.lastDisconnectReason).toContain('1006');

    // Simulate successful reconnect
    (ws as any).sessionTotalReconnectSuccesses++;
    const statsAfterRecon = ws.getStats();
    expect(statsAfterRecon.sessionTotalReconnectAttempts).toBe(1);
    expect(statsAfterRecon.sessionTotalReconnectSuccesses).toBe(1);
    expect(statsAfterRecon.reconnectCount).toBe(1);
  });

  // TASK 2 & 3: Route Index O(1) sets and fail-closed readiness on WS disconnect
  it('RouteIndex blocks READY routes when WS is disconnected and invalidates existing READY routes', () => {
    const routeIndex = new RouteIndex([]);
    const routeId = 'ROUTE_USDC_SOL_ORCA_RAY';

    (routeIndex as any).routeById.set(routeId, {
      routeId,
      cycleType: '2_LEG',
      isDirectToDirect: true,
      legs: [
        { pool: { id: 'pool1', dex: 'ORCA_WHIRLPOOL' } },
        { pool: { id: 'pool2', dex: 'RAYDIUM_AMM' } }
      ],
      state: 'VERIFIED'
    });
    (routeIndex as any).routesByState.get('VERIFIED').add(routeId);

    // Feed is connected initially
    routeIndex.setWsFeedConnected(true);
    const readySuccess = routeIndex.setRouteReady(routeId, { expectedNetUSDC: '0.50', timestamp: Date.now() });
    expect(readySuccess).toBe(true);
    expect(routeIndex.getReadyRouteCount()).toBe(1);
    expect(routeIndex.getReadyRoutes().length).toBe(1);

    // Feed drops -> setWsFeedConnected(false) immediately invalidates all READY routes
    routeIndex.setWsFeedConnected(false);
    expect(routeIndex.getReadyRouteCount()).toBe(0);
    expect(routeIndex.getReadyRoutes().length).toBe(0);

    // While disconnected, setRouteReady MUST fail closed
    const setReadyWhileDown = routeIndex.setRouteReady(routeId, { expectedNetUSDC: '0.60', timestamp: Date.now() });
    expect(setReadyWhileDown).toBe(false);
    expect(routeIndex.getReadyRouteCount()).toBe(0);

    // Fast O(1) state lookups
    expect(routeIndex.getRouteCountByState('READY')).toBe(0);
    expect(routeIndex.getRouteCountByState('STALE')).toBe(1);
  });

  // TASK 5: 24-Hour Study Metrics (Duration deduplication, null for unmonitored / 0 reval)
  it('OpportunityWindowTracker does not artificially inflate duration on duplicate unchanged snapshots', () => {
    const tracker = new OpportunityWindowTracker({ profitHurdleUSDC: 0.10 });
    const startTime = 1700000000000;
    const currentSlot = 250000;

    const candidate: ArbitrageCandidate = {
      candidateId: 'cand_1',
      routeName: 'USDC -> SOL -> USDC',
      inputAmountUSDC: 100000000n,
      expectedNetUSDC: '0.5000',
      minConservativeNetUSDC: '0.3500',
      confidenceScore: 90,
      survivalStatus: 'SURVIVED',
      status: 'QUALIFIED_SHADOW',
      rejectionReasons: [],
      timestamp: startTime,
      stateVersion: 'slot_250000_v1',
      leg1Quote: { dex: 'ORCA_WHIRLPOOL', poolId: 'p1', inputMint: 'USDC', outputMint: 'SOL', inAmount: 100000000n, outAmount: 1000000n, slot: currentSlot } as any,
      leg2Quote: { dex: 'RAYDIUM_AMM', poolId: 'p2', inputMint: 'SOL', outputMint: 'USDC', inAmount: 1000000n, outAmount: 100350000n, slot: currentSlot } as any,
      costs: {
        networkFeeUSDC: '0.0010',
        priorityFeeUSDC: '0.0020',
        jitoTipUSDC: '0.0000',
        tokenTransferFeesUSDC: '0.0000',
        contingencyUSDC: '0.0200',
        safetyBufferUSDC: '0.2500',
        totalCostsUSDC: '0.2730',
        solPriceUSDC: '150.00'
      } as any
    } as unknown as ArbitrageCandidate;

    // First genuine observation
    tracker.recordEvaluation(candidate, undefined, currentSlot, true, true, startTime);
    const openWindows = tracker.getAllOpenWindows();
    expect(openWindows.length).toBe(1);
    expect(openWindows[0].observedDurationMs).toBe(0);

    // Duplicate snapshot 500ms later (identical slot and stateVersion)
    tracker.recordEvaluation(candidate, undefined, currentSlot, true, true, startTime + 500);
    expect(openWindows[0].observedDurationMs).toBe(0); // Duration must NOT advance on identical duplicate snapshot!
    expect(openWindows[0].lastObservedAt).toBe(startTime); // lastObservedAt remains at the genuine observation time

    // Genuine update 1200ms later (advanced slot and state version)
    const updatedCandidate: ArbitrageCandidate = {
      ...candidate,
      stateVersion: 'slot_250003_v2',
      minConservativeNetUSDC: '0.4000'
    };
    tracker.recordEvaluation(updatedCandidate, undefined, currentSlot + 3, true, true, startTime + 1200);
    expect(openWindows[0].observedDurationMs).toBe(1200); // Advances on genuine market state transition
    expect(openWindows[0].lastObservedAt).toBe(startTime + 1200);
  });

  it('OpportunityWindowTracker returns null (N/A / Pending) for future hours and 0 revalidation rates', () => {
    const tracker = new OpportunityWindowTracker({ profitHurdleUSDC: 0.10 });
    const now = tracker.getStartedAt() + 1800000; // 30 minutes into study (Hour 0)

    const buckets = tracker.getHourlyProfitabilityBuckets(now);
    expect(buckets.length).toBe(24);

    // Hour 0 (active, but 0 revalidations evaluated yet)
    expect(buckets[0].status).toBe('NO_OPPORTUNITIES_VERIFIED');
    expect(buckets[0].revalidationSuccessPct).toBeNull(); // N/A, not misleading 100%!

    // Future hours (Hour 1..23)
    for (let h = 1; h < 24; h++) {
      expect(buckets[h].status).toBe('FUTURE');
      expect(buckets[h].healthyCoveragePct).toBeNull(); // Pending, not misleading 100%!
      expect(buckets[h].revalidationSuccessPct).toBeNull(); // Pending, not misleading 100%!
    }

    // Telemetry also returns null for revalidation rate when 0 revalidations checked
    const telem = tracker.getTelemetry(now);
    expect(telem.revalidationSuccessPct).toBeNull();
  });

  // TASK 6: Unify Profit Hurdles
  it('Updating ProfitThresholdManager updates OpportunityWindowTracker hurdle synchronously', () => {
    const testFile = `data/test_sync_hurdle_${Date.now()}.json`;
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

    try {
      const thresholdMgr = new ProfitThresholdManager({ filePath: testFile, initialThresholdUSDC: 0.10, silent: true });
      const tracker = new OpportunityWindowTracker({ profitHurdleUSDC: 0.10 });

      // Wire listener as in ArbitrageScanner
      thresholdMgr.onThresholdChange((newUSDC) => {
        tracker.setProfitHurdle(newUSDC);
      });

      expect(tracker.getProfitHurdle()).toBe(0.10);
      expect(tracker.getTelemetry().profitHurdleUSDC).toBe(0.10);

      // Update threshold to $0.25
      const res = thresholdMgr.setThreshold(0.25);
      expect(res.success).toBe(true);
      expect(tracker.getProfitHurdle()).toBe(0.25);
      expect(tracker.getTelemetry().profitHurdleUSDC).toBe(0.25);
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      if (fs.existsSync('data/test_sync_hurdle.json')) fs.unlinkSync('data/test_sync_hurdle.json');
    }
  });

  // TASK 8: Clean Profit Watch Table
  it('Scanner getProfitWatchTable returns empty list when buffer is empty, never synthetic mock data', () => {
    const scanner = new ArbitrageScanner(config);
    const watchTable = scanner.getProfitWatchTable(10);
    expect(watchTable).toEqual([]); // Clean empty array, no fake rows with -0.25!
  });
});
