import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OpportunityWindowTracker } from '../src/study/windowTracker.js';
import { StudyReportGenerator } from '../src/study/studyReportGenerator.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { config } from '../src/config/index.js';
import {
  ArbitrageCandidate,
  WindowClosureReason,
  SwapQuote
} from '../src/types/index.js';

function createMockCandidate(overrides: Partial<ArbitrageCandidate> = {}): ArbitrageCandidate {
  const quote1: SwapQuote = {
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool_raydium_sol_usdc',
    dex: 'RAYDIUM_AMM',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmount: 100_000_000n,
    outAmount: 500_000_000n,
    feeIncluded: true,
    feeAmount: 250_000n,
    priceImpactBps: 5,
    slot: 1000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC'
  };

  const quote2: SwapQuote = {
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool_orca_sol_usdc',
    dex: 'ORCA_WHIRLPOOL',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: 500_000_000n,
    outAmount: 101_500_000n,
    feeIncluded: true,
    feeAmount: 300_000n,
    priceImpactBps: 8,
    slot: 1000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC'
  };

  return {
    candidateId: `cand_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    routeName: 'SOL (Raydium -> Orca)',
    direction: 'USDC -> SOL -> USDC',
    cycleType: '2_LEG',
    qualityLabel: 'SHADOW_QUALIFIED',
    optimalSizeUSDC: 100,
    inputAmountUSDC: 100_000_000n,
    leg1Quote: quote1,
    leg1ExpectedOutWSOL: 500_000_000n,
    leg1ConservativeOutWSOL: 499_500_000n,
    leg2Quote: quote2,
    leg2ExpectedOutUSDC: 101_500_000n,
    leg2ConservativeOutUSDC: 101_250_000n,
    costs: {
      networkFeeUSDC: '0.0010',
      priorityFeeUSDC: '0.0050',
      jitoTipUSDC: '0.0100',
      tokenTransferFeesUSDC: '0.0000',
      contingencyUSDC: '0.0100',
      safetyBufferUSDC: '0.2500',
      totalCostsUSDC: '0.2760',
      solPriceUSDC: '200.00',
      assumptions: ['Simulated benchmark costs']
    },
    expectedNetUSDC: '1.2240',
    minConservativeNetUSDC: '0.9740',
    status: 'QUALIFIED_SHADOW',
    rejectionReasons: [],
    timestamp: Date.now(),
    slotGap: 0,
    quoteAgeMs: 50,
    survivalStatus: 'SURVIVED',
    stateVersion: 'pool_raydium:1000|pool_orca:1000',
    ...overrides
  };
}

describe('24-Hour Profitability & Opportunity Window Study Suite', () => {
  let testDbPath: string;
  let testRepo: ArbitrageRepository;
  const testReportsDir = path.join(process.cwd(), 'reports', 'test_24h_reports');

  beforeEach(() => {
    testDbPath = path.join(process.cwd(), `test_study_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.db`);
    const customConfig = { ...config, DB_PATH: testDbPath };
    testRepo = new ArbitrageRepository(customConfig);

    if (fs.existsSync(testReportsDir)) {
      fs.rmSync(testReportsDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    testRepo.close();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    if (fs.existsSync(testReportsDir)) {
      try { fs.rmSync(testReportsDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('Requirement 1: Opens a new opportunity window on qualified survived candidate', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_1',
      profitHurdleUSDC: 0.50,
      repository: testRepo
    });

    const candidate = createMockCandidate({
      minConservativeNetUSDC: '1.2500',
      status: 'QUALIFIED_SHADOW',
      survivalStatus: 'SURVIVED'
    });

    tracker.recordEvaluation(candidate, undefined, 1050, true, true);

    const openWindows = tracker.getAllOpenWindows();
    expect(openWindows.length).toBe(1);

    const win = openWindows[0];
    expect(win.sessionId).toBe('test_session_1');
    expect(win.routeId).toBe(candidate.routeName);
    expect(win.tradeSizeUSDC).toBe(100);
    expect(win.status).toBe('OPEN');
    expect(win.revalidationStatus).toBe('SURVIVED');
    expect(win.netProfitOpeningUSDC).toBe(1.25);
    expect(win.netProfitPeakUSDC).toBe(1.25);
    expect(win.observationCount).toBe(1);
    expect(win.durationLowerBoundMs).toBe(0);
    expect(win.isCensored).toBe(false);

    // Verify persisted in SQLite
    const persisted = testRepo.getOpportunityWindowsForSession('test_session_1');
    expect(persisted.length).toBe(1);
    expect(persisted[0].windowId).toBe(win.windowId);
    expect(persisted[0].netProfitOpeningUSDC).toBe(1.25);
  });

  it('Requirement 2: Continuous qualified evaluations update existing window without creating duplicates', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_2',
      profitHurdleUSDC: 0.50,
      repository: testRepo
    });

    const cand1 = createMockCandidate({
      minConservativeNetUSDC: '0.8000',
      stateVersion: 'v1'
    });
    tracker.recordEvaluation(cand1, undefined, 1001);

    // Second evaluation with new state and higher net profit
    const cand2 = createMockCandidate({
      minConservativeNetUSDC: '1.5000',
      stateVersion: 'v2'
    });
    tracker.recordEvaluation(cand2, undefined, 1002);

    // Third evaluation with lower net profit but still above hurdle
    const cand3 = createMockCandidate({
      minConservativeNetUSDC: '0.6500',
      stateVersion: 'v3'
    });
    tracker.recordEvaluation(cand3, undefined, 1003);

    const openWindows = tracker.getAllOpenWindows();
    expect(openWindows.length).toBe(1);

    const win = openWindows[0];
    expect(win.observationCount).toBe(3);
    expect(win.netProfitOpeningUSDC).toBe(0.80);
    expect(win.netProfitPeakUSDC).toBe(1.50);
    expect(win.netProfitMinUSDC).toBe(0.65);
    expect(win.status).toBe('OPEN');
  });

  it('Requirement 3: Deduplication ignores unchanged market snapshot', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_3',
      profitHurdleUSDC: 0.50,
      repository: testRepo
    });

    const cand1 = createMockCandidate({
      minConservativeNetUSDC: '1.0000',
      stateVersion: 'static_v1'
    });
    tracker.recordEvaluation(cand1, undefined, 1050);

    // Repeated evaluation with IDENTICAL slot and IDENTICAL stateVersion
    const candDuplicate = createMockCandidate({
      minConservativeNetUSDC: '1.0000',
      stateVersion: 'static_v1'
    });
    tracker.recordEvaluation(candDuplicate, undefined, 1050);

    const win = tracker.getAllOpenWindows()[0];
    expect(win.observationCount).toBe(1); // Not incremented falsely
  });

  it('Requirement 4: Closes window with natural market reason when profitability drops', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_4',
      profitHurdleUSDC: 0.50,
      repository: testRepo
    });

    // 1. Open window
    tracker.recordEvaluation(createMockCandidate({ minConservativeNetUSDC: '0.9000' }), undefined, 100);
    expect(tracker.getAllOpenWindows().length).toBe(1);

    // 2. Net drops below hurdle ($0.30 < $0.50) while expected net remains positive
    const dropCandidate = createMockCandidate({
      status: 'REJECTED',
      minConservativeNetUSDC: '0.3000',
      expectedNetUSDC: '0.4500',
      rejectionReasons: []
    });
    tracker.recordEvaluation(dropCandidate, undefined, 101);

    expect(tracker.getAllOpenWindows().length).toBe(0);
    const closedWindows = tracker.getAllClosedWindows();
    expect(closedWindows.length).toBe(1);

    const closed = closedWindows[0];
    expect(closed.status).toBe('CLOSED');
    expect(closed.closureReason).toBe(WindowClosureReason.TARGET_SHORTFALL);
    expect(closed.isCensored).toBe(false);
    expect(closed.netProfitClosingUSDC).toBe(0.30);
  });

  it('Requirement 5: Identifies SPREAD_COMPRESSION when expected net turns non-positive', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_5',
      profitHurdleUSDC: 0.50
    });

    tracker.recordEvaluation(createMockCandidate({ minConservativeNetUSDC: '0.9000' }), undefined, 100);

    const compressed = createMockCandidate({
      status: 'REJECTED',
      expectedNetUSDC: '-0.1500',
      minConservativeNetUSDC: '-0.4000',
      rejectionReasons: []
    });
    tracker.recordEvaluation(compressed, undefined, 102);

    const closed = tracker.getAllClosedWindows()[0];
    expect(closed.status).toBe('CLOSED');
    expect(closed.closureReason).toBe(WindowClosureReason.SPREAD_COMPRESSION);
    expect(closed.isCensored).toBe(false);
  });

  it('Requirement 6: Tracks different trade sizes separately on the same route', () => {
    const tracker = new OpportunityWindowTracker({ sessionId: 'test_session_6' });

    // $100 size
    const cand100 = createMockCandidate({
      inputAmountUSDC: 100_000_000n,
      minConservativeNetUSDC: '0.8500'
    });
    tracker.recordEvaluation(cand100, undefined, 200);

    // $500 size on the same route
    const cand500 = createMockCandidate({
      inputAmountUSDC: 500_000_000n,
      minConservativeNetUSDC: '2.1000'
    });
    tracker.recordEvaluation(cand500, undefined, 200);

    const openWindows = tracker.getAllOpenWindows();
    expect(openWindows.length).toBe(2);

    const size100Win = openWindows.find(w => w.tradeSizeUSDC === 100);
    const size500Win = openWindows.find(w => w.tradeSizeUSDC === 500);

    expect(size100Win).toBeDefined();
    expect(size500Win).toBeDefined();
    expect(size100Win?.netProfitPeakUSDC).toBe(0.85);
    expect(size500Win?.netProfitPeakUSDC).toBe(2.10);
  });

  it('Requirement 7: Marks open windows as INTERRUPTED_CENSORED on WebSocket disconnect', () => {
    const tracker = new OpportunityWindowTracker({ sessionId: 'test_session_7' });

    tracker.recordEvaluation(createMockCandidate(), undefined, 300);
    expect(tracker.getAllOpenWindows().length).toBe(1);

    // Simulate WebSocket disconnect
    tracker.onWebSocketDisconnect(Date.now(), 301);

    expect(tracker.getAllOpenWindows().length).toBe(0);
    const closed = tracker.getAllClosedWindows();
    expect(closed.length).toBe(1);
    expect(closed[0].status).toBe('INTERRUPTED_CENSORED');
    expect(closed[0].closureReason).toBe(WindowClosureReason.WS_DISCONNECTED);
    expect(closed[0].isCensored).toBe(true);
  });

  it('Requirement 8: Purges un-updated windows after quote expiry as censored', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_8',
      quoteExpiryMs: 1500
    });

    const now = Date.now();
    tracker.recordEvaluation(createMockCandidate(), undefined, 400);

    // Before expiry: still open
    tracker.purgeExpiredWindows(now + 1000, 402);
    expect(tracker.getAllOpenWindows().length).toBe(1);

    // After expiry (> 1500ms): closed as censored
    tracker.purgeExpiredWindows(now + 1600, 404);
    expect(tracker.getAllOpenWindows().length).toBe(0);

    const closed = tracker.getAllClosedWindows();
    expect(closed.length).toBe(1);
    expect(closed[0].closureReason).toBe(WindowClosureReason.QUOTE_EXPIRED);
    expect(closed[0].isCensored).toBe(true);
  });

  it('Requirement 9: Computes duration percentiles strictly from CLOSED windows (censored excluded)', () => {
    const tracker = new OpportunityWindowTracker({ sessionId: 'test_session_9' });

    // Helper to simulate a closed window with specific duration
    const addSimulatedWindow = (
      id: string,
      status: 'CLOSED' | 'INTERRUPTED_CENSORED',
      durMs: number,
      reason: string
    ) => {
      const now = Date.now();
      const win = {
        windowId: id,
        sessionId: 'test_session_9',
        routeId: 'route_1',
        tokenMint: 'mint_1',
        tokenSymbol: 'SOL',
        buyDex: 'RAYDIUM',
        buyPoolId: 'p1',
        sellDex: 'ORCA',
        sellPoolId: 'p2',
        tradeSizeUSDC: 100,
        status,
        closureReason: reason,
        isCensored: status === 'INTERRUPTED_CENSORED',
        revalidationStatus: 'SURVIVED' as const,
        firstObservedAt: now - durMs,
        firstObservedSlot: 100,
        firstObservedMonotonic: now - durMs,
        lastObservedAt: now,
        lastObservedSlot: 105,
        lastObservedMonotonic: now,
        closedAt: now,
        closedAtSlot: 105,
        closedAtMonotonic: now,
        durationLowerBoundMs: durMs,
        durationUpperBoundMs: durMs,
        netProfitOpeningUSDC: 1.0,
        netProfitPeakUSDC: 1.0,
        netProfitMinUSDC: 1.0,
        observationCount: 3,
        historyObservations: []
      };
      (tracker as any).closedWindows.push(win);
    };

    // 4 CLOSED windows: 200ms, 400ms, 1200ms, 3000ms
    addSimulatedWindow('w1', 'CLOSED', 200, WindowClosureReason.TARGET_SHORTFALL);
    addSimulatedWindow('w2', 'CLOSED', 400, WindowClosureReason.SPREAD_COMPRESSION);
    addSimulatedWindow('w3', 'CLOSED', 1200, WindowClosureReason.TARGET_SHORTFALL);
    addSimulatedWindow('w4', 'CLOSED', 3000, WindowClosureReason.LIQUIDITY_DROP);

    // 2 CENSORED windows: 50,000ms (Must NOT distort market distributions!)
    addSimulatedWindow('c1', 'INTERRUPTED_CENSORED', 50000, WindowClosureReason.WS_DISCONNECTED);
    addSimulatedWindow('c2', 'INTERRUPTED_CENSORED', 90000, WindowClosureReason.QUOTE_EXPIRED);

    const percentiles = tracker.calculateDurationPercentiles();
    expect(percentiles.count).toBe(4);
    expect(percentiles.minMs).toBe(200);
    expect(percentiles.maxMs).toBe(3000); // 3000ms, NOT 90000ms!
    expect(percentiles.under500msCount).toBe(2); // 200ms, 400ms
    expect(percentiles.between500msAnd2sCount).toBe(1); // 1200ms
    expect(percentiles.over2sCount).toBe(1); // 3000ms
  });

  it('Requirement 10: Records near misses without classifying as qualified windows', () => {
    const tracker = new OpportunityWindowTracker({
      sessionId: 'test_session_10',
      profitHurdleUSDC: 0.50
    });

    const nearMissCandidate = createMockCandidate({
      status: 'REJECTED',
      expectedNetUSDC: '0.4200',
      minConservativeNetUSDC: '0.2800', // Positive but below $0.50 hurdle
      rejectionReasons: []
    });

    tracker.recordEvaluation(nearMissCandidate, undefined, 500);

    expect(tracker.getAllOpenWindows().length).toBe(0);
    const nearMisses = tracker.getNearMisses();
    expect(nearMisses.length).toBe(1);
    expect(nearMisses[0].conservativeNetUSDC).toBe(0.28);
    expect(nearMisses[0].shortfallUSDC).toBeCloseTo(0.22, 2);
  });

  it('Requirement 11: Accurately accumulates healthy uptime vs feed downtime', () => {
    const tracker = new OpportunityWindowTracker({ sessionId: 'test_session_11' });
    const start = tracker.getStartedAt();

    // 10 seconds of healthy uptime
    tracker.updateFeedUptime(true, true, start + 10000);
    // 5 seconds of downtime (WS down)
    tracker.updateFeedUptime(false, true, start + 15000);
    // 5 seconds of downtime (RPC down)
    tracker.updateFeedUptime(true, false, start + 20000);
    // 10 seconds of healthy uptime
    tracker.updateFeedUptime(true, true, start + 30000);

    const telem = tracker.getTelemetry(start + 30000);
    expect(telem.healthyUptimeMs).toBe(20000);
    expect(telem.feedDowntimeMs).toBe(10000);
    expect(telem.elapsedMs).toBe(30000);
  });

  it('Requirement 12: Generates all 3 study reports (CSV, JSON, TXT) across Sections A-F with honest 0-opportunity handling', () => {
    const tracker = new OpportunityWindowTracker({ sessionId: 'test_session_12' });
    const generator = new StudyReportGenerator(tracker, testReportsDir);

    // 1. Generate with 0 opportunities
    const emptyOutputs = generator.generateAllReports();
    expect(fs.existsSync(emptyOutputs.csvPath)).toBe(true);
    expect(fs.existsSync(emptyOutputs.jsonPath)).toBe(true);
    expect(fs.existsSync(emptyOutputs.txtPath)).toBe(true);

    const emptyTxt = fs.readFileSync(emptyOutputs.txtPath, 'utf8');
    expect(emptyTxt).toContain('SOLANABOT - 24-HOUR PROFITABILITY & OPPORTUNITY WINDOW STUDY REPORT');
    expect(emptyTxt).toContain('SECTION A: SCAN COVERAGE & OPERATIONAL HEALTH');
    expect(emptyTxt).toContain('SECTION B: ROUTE DISCOVERY & OPPORTUNITY FUNNEL');
    expect(emptyTxt).toContain('SECTION C: PROFITABILITY DISTRIBUTION & UNIT ECONOMICS');
    expect(emptyTxt).toContain('SECTION D: OPPORTUNITY WINDOW DURATION ANALYSIS');
    expect(emptyTxt).toContain('SECTION E: TOP MOST PROFITABLE OPPORTUNITY WINDOWS');
    expect(emptyTxt).toContain('SECTION F: ECONOMIC FEASIBILITY & STRATEGY RECOMMENDATIONS');
    expect(emptyTxt).toContain('No qualified profitable opportunity windows were observed');

    // 2. Add an opportunity and verify complete report populated
    tracker.recordEvaluation(createMockCandidate({ minConservativeNetUSDC: '1.4500' }), undefined, 600);
    tracker.completeStudy('STUDY_COMPLETED');

    const populatedOutputs = generator.generateAllReports();
    const csvContent = fs.readFileSync(populatedOutputs.csvPath, 'utf8');
    expect(csvContent).toContain('SOL (Raydium -> Orca)');
    expect(csvContent).toContain('1.4500');

    const jsonContent = JSON.parse(fs.readFileSync(populatedOutputs.jsonPath, 'utf8'));
    expect(jsonContent.studySessionId).toBe('test_session_12');
    expect(jsonContent.routesAndOpportunities.totalQualifiedWindows).toBe(1);
    expect(jsonContent.profitability.bestConservativeNetUSDC).toBe('1.4500');
  });
});
