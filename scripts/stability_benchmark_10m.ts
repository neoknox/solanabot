import { loadConfig } from '../src/config/index.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import fs from 'fs';
import path from 'path';

async function runBenchmark(durationSeconds = 600) {
  console.log('================================================================');
  console.log('SOLANABOT — 10-MINUTE MAINNET READ-ONLY STABILITY BENCHMARK');
  console.log(`Target Duration: ${durationSeconds} seconds (${(durationSeconds / 60).toFixed(1)} minutes)`);
  console.log('Mode: READ-ONLY SHADOW MODE (Zero live trading / no private keys)');
  console.log('================================================================\n');

  const config = loadConfig();
  const repository = new ArbitrageRepository(config);

  // 1. Database Route Count Preservation Verification
  const initialRouteCount = repository.getRouteCount();
  console.log(`[DB] Initial stored route count: ${initialRouteCount} routes`);
  if (initialRouteCount < 10000) {
    console.warn(`[WARN] Route count (${initialRouteCount}) is lower than expected full library (~38k).`);
  }

  // 2. Profit Threshold Verification
  const thresholdManager = new ProfitThresholdManager();
  console.log(`[THRESHOLD] Active runtime threshold: ${thresholdManager.getFormattedThreshold()} ($${thresholdManager.getThresholdUSDC()} USDC)`);
  if (thresholdManager.getThresholdUSDC() !== 0.10) {
    console.error(`[ERROR] Hurdle is not $0.10 USDC! Found: $${thresholdManager.getThresholdUSDC()}`);
    process.exit(1);
  }

  // 3. Initialize Scanner
  const scanner = new ArbitrageScanner(
    config,
    undefined,
    undefined,
    undefined,
    repository,
    thresholdManager
  );

  // Start scanner
  console.log('[SCANNER] Starting ArbitrageScanner on Solana Mainnet...');
  const startTime = Date.now();
  await scanner.start();
  console.log('[SCANNER] Scanner started successfully. Monitoring stability metrics...\n');

  // Event loop delay sampling during active scanning steady-state
  const eventLoopDelays: number[] = [];
  let lastLoopCheck = performance.now();
  const loopInterval = setInterval(() => {
    const now = performance.now();
    const delay = Math.max(0, now - lastLoopCheck - 50);
    eventLoopDelays.push(delay);
    lastLoopCheck = now;
  }, 50);

  let wsDropsObserved = 0;
  let maxReadyWhileDisconnected = 0;
  const samples: Array<{
    elapsedSec: number;
    wsConnected: boolean;
    wsStatus: string;
    slot: number | null;
    readyRoutes: number;
    verifiedRoutes: number;
    quoteValidPct: number;
    rpcP95Ms: number;
    eventLoopDelayMs: number;
  }> = [];

  const monitorInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const hud = scanner.getHudV2Data();
    const wsStats = scanner.getWsStats();

    const wsConnected = hud.wsConnected;
    const readyRoutes = hud.routeHealth?.readyRoutes || 0;

    // Invariant check: READY routes must NEVER be > 0 when WS is disconnected
    if (!wsConnected && readyRoutes > 0) {
      maxReadyWhileDisconnected = Math.max(maxReadyWhileDisconnected, readyRoutes);
      console.error(`[CRITICAL INVARIANT VIOLATION] WS disconnected but ${readyRoutes} routes are marked READY!`);
    }

    samples.push({
      elapsedSec,
      wsConnected,
      wsStatus: hud.wsStatus,
      slot: hud.solanaSlot,
      readyRoutes,
      verifiedRoutes: hud.routeHealth?.verifiedRoutes || 0,
      quoteValidPct: hud.performance?.quoteValidPercentage || 0,
      rpcP95Ms: hud.performance?.rpcLatencyP95Ms || 0,
      eventLoopDelayMs: hud.diagnostics?.eventLoopDelayMs || 0
    });

    if (elapsedSec % 15 === 0 || elapsedSec === durationSeconds) {
      const loopRecent = eventLoopDelays.slice(-300);
      const loopP95 = loopRecent.length > 0 ? loopRecent.sort((a, b) => a - b)[Math.floor(loopRecent.length * 0.95)] : 0;
      console.log(
        `[T+${String(elapsedSec).padStart(3, '0')}s] ` +
        `WS: ${hud.wsStatus} (drops: ${wsStats.sessionTotalDisconnects}) | ` +
        `Slot: ${hud.solanaSlot || '--'} | ` +
        `READY: ${readyRoutes} | ` +
        `RPC p95: ${hud.performance?.rpcLatencyP95Ms?.toFixed(1) || 0}ms | ` +
        `Loop p95: ${loopP95.toFixed(1)}ms | ` +
        `QuoteValid: ${hud.performance?.quoteValidPercentage?.toFixed(1) || 0}% | ` +
        `Hurdle: ${hud.formattedThreshold}`
      );
    }

    if (elapsedSec >= durationSeconds) {
      clearInterval(monitorInterval);
      clearInterval(loopInterval);
      finishBenchmark();
    }
  }, 1000);

  function finishBenchmark() {
    const totalElapsedMs = Date.now() - startTime;
    const hud = scanner.getHudV2Data();
    const wsStats = scanner.getWsStats();
    const studyTelem = scanner.getWindowTracker().getTelemetry();

    // Event loop statistics
    eventLoopDelays.sort((a, b) => a - b);
    const loopCount = eventLoopDelays.length;
    const loopMin = loopCount > 0 ? eventLoopDelays[0] : 0;
    const loopMedian = loopCount > 0 ? eventLoopDelays[Math.floor(loopCount * 0.50)] : 0;
    const loopP95 = loopCount > 0 ? eventLoopDelays[Math.floor(loopCount * 0.95)] : 0;
    const loopMax = loopCount > 0 ? eventLoopDelays[loopCount - 1] : 0;

    // Feed uptime
    const totalDrops = wsStats.sessionTotalDisconnects;
    const feedUptimePct = totalElapsedMs > 0
      ? Math.max(0, Math.min(100.0, Number((100.0 - (studyTelem.feedDowntimeMs / totalElapsedMs * 100)).toFixed(2))))
      : 100.0;

    // Database route count preservation check
    const finalRouteCount = repository.getRouteCount();

    console.log('\n================================================================');
    console.log('10-MINUTE STABILITY BENCHMARK RESULTS');
    console.log('================================================================');
    console.log(`Elapsed Time:                   ${(totalElapsedMs / 1000).toFixed(1)}s`);
    console.log(`Feed Uptime:                    ${feedUptimePct}% (${studyTelem.healthyUptimeMs}ms healthy / ${studyTelem.feedDowntimeMs}ms downtime)`);
    console.log(`WebSocket Disconnects:          ${totalDrops} drops`);
    console.log(`Reconnect Attempts / Success:   ${wsStats.sessionTotalReconnectAttempts} / ${wsStats.sessionTotalReconnectSuccesses}`);
    console.log(`Event-Loop Delay:               Median: ${loopMedian.toFixed(2)}ms | p95: ${loopP95.toFixed(2)}ms | Max: ${loopMax.toFixed(2)}ms`);
    console.log(`RPC p95 Latency:                ${hud.performance?.rpcLatencyP95Ms?.toFixed(1) || 0} ms`);
    console.log(`Route Readiness Invariant:      Violations: ${maxReadyWhileDisconnected} (Target: 0)`);
    console.log(`Quote-Valid Percentage:         ${hud.performance?.quoteValidPercentage?.toFixed(1) || 0}%`);
    console.log(`Total Stored Routes (DB):       ${finalRouteCount} (Initial: ${initialRouteCount})`);
    console.log(`Profit Hurdle (Unified):        $${studyTelem.profitHurdleUSDC.toFixed(2)} USDC (HUD: $${hud.thresholdUSDC.toFixed(2)} USDC)`);
    console.log(`Study Qualified Windows:        ${studyTelem.totalQualifiedWindows} (${studyTelem.completedQualifiedWindows} completed, ${studyTelem.openQualifiedWindows} open)`);
    console.log(`Study Revalidation Survival:    ${studyTelem.revalidationSuccessPct !== null ? studyTelem.revalidationSuccessPct.toFixed(1) + '%' : 'N/A'}`);
    console.log(`Study Hour 0 Status:            ${studyTelem.hourlyBuckets[0]?.status || 'UNKNOWN'}`);
    console.log(`Study Hour 1 (Future) Status:   ${studyTelem.hourlyBuckets[1]?.status || 'UNKNOWN'} (Coverage: ${studyTelem.hourlyBuckets[1]?.healthyCoveragePct ?? 'null'})`);
    console.log('================================================================\n');

    // Save benchmark report JSON to data
    const benchmarkReport = {
      timestamp: new Date().toISOString(),
      durationSeconds,
      elapsedMs: totalElapsedMs,
      feedUptimePct,
      totalDrops,
      wsStats,
      eventLoop: { minMs: loopMin, medianMs: loopMedian, p95Ms: loopP95, maxMs: loopMax },
      rpcLatencyP95Ms: hud.performance?.rpcLatencyP95Ms,
      quoteValidPct: hud.performance?.quoteValidPercentage,
      routeReadinessViolations: maxReadyWhileDisconnected,
      routesDatabase: { initial: initialRouteCount, final: finalRouteCount, preserved: finalRouteCount >= initialRouteCount },
      hurdleUSDC: studyTelem.profitHurdleUSDC,
      studyTelemetry: studyTelem
    };

    const outPath = path.resolve('data/stability_benchmark_10m.json');
    fs.writeFileSync(outPath, JSON.stringify(benchmarkReport, null, 2), 'utf-8');
    console.log(`[REPORT] Benchmark telemetry saved to ${outPath}`);

    scanner.stop();
    repository.close();
    process.exit(0);
  }
}

const durationArg = process.argv[2] ? parseInt(process.argv[2], 10) : 600;
runBenchmark(durationArg).catch((err) => {
  console.error('[BENCHMARK FATAL ERROR]:', err);
  process.exit(1);
});
