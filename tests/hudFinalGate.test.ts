import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import Decimal from 'decimal.js';
import {
  ProfitThresholdManager,
  VALID_PROFIT_THRESHOLDS_CENTS,
  DEFAULT_PROFIT_THRESHOLD_CENTS
} from '../src/profit/profitThresholdManager.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { loadConfig, CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT } from '../src/config/index.js';
import { ArbitrageCandidate, SwapQuote, CostBreakdown } from '../src/types/index.js';

describe('Phase 1.3: HUD Final Gate & Telemetry Verification Suite', () => {
  const testDir = path.join(process.cwd(), 'data', 'test_hud_final_gate');

  const safeCleanup = () => {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  };

  beforeEach(() => {
    safeCleanup();
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    safeCleanup();
  });

  function getUniqueTestFiles() {
    const id = Math.random().toString(36).substring(2, 8);
    return {
      thresholdFile: path.join(testDir, `profit_threshold_${id}.json`),
      dbFile: path.join(testDir, `test_scanner_${id}.db`)
    };
  }

  function createValidQuote(overrides: Partial<SwapQuote> = {}): SwapQuote {
    return {
      quoteSource: 'DIRECT_POOL',
      poolId: 'test-pool-1',
      dex: 'ORCA_WHIRLPOOL',
      inputMint: CANONICAL_USDC_MINT,
      outputMint: CANONICAL_WSOL_MINT,
      inAmount: 100_000_000n, // 100 USDC
      outAmount: 500_000_000n, // 0.5 WSOL
      feeIncluded: true,
      feeAmount: 500n,
      priceImpactBps: 5,
      slot: 1000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC',
      ...overrides
    };
  }

  function createValidCosts(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
    return {
      networkFeeUSDC: '0.001000',
      priorityFeeUSDC: '0.002000',
      jitoTipUSDC: '0.000000',
      tokenTransferFeesUSDC: '0.000000',
      contingencyUSDC: '0.020000',
      safetyBufferUSDC: '0.250000',
      totalCostsUSDC: '0.023000',
      solPriceUSDC: '200.00',
      recoverableDepositUSDC: '0.000000',
      consumedCostUSDC: '0.003000',
      potentialLossOnFailureUSDC: '0.003000',
      assumptions: ['deterministic test cost model'],
      ...overrides
    };
  }

  // 1. One Connected HUD & Occupied Port Handling
  it('handles an occupied HUD port with immediate EADDRINUSE error, never waiting indefinitely', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    // Start server A on an ephemeral port
    const managerA = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const serverA = new ProfitHudServer(managerA, undefined, { port: 0, silent: true });
    const { port } = await serverA.start();

    try {
      // Attempt to start server B on the exact same port
      const managerB = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
      const serverB = new ProfitHudServer(managerB, undefined, { port, silent: true });

      let rejectedError: any = null;
      try {
        await serverB.start();
      } catch (err) {
        rejectedError = err;
      }

      expect(rejectedError).not.toBeNull();
      expect(rejectedError.code).toBe('EADDRINUSE');
      expect(rejectedError.message).toContain(`HUD port ${port} is already occupied`);
    } finally {
      await serverA.stop();
    }
  });

  // 2. Persistence Write Failure: Reverts to previous confirmed value without updating scanner
  it('on persistence write failure: keeps previous confirmed threshold, returns actionable error, and leaves listener unchanged', () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    expect(manager.getThresholdUSDC()).toBe(0.50);

    let listenerCallCount = 0;
    manager.onThresholdChange(() => {
      listenerCallCount++;
    });

    // Mock saveToDiskSync to throw an atomic rename/write error
    vi.spyOn(manager, 'saveToDiskSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, rename temp file to target');
    });

    // Attempt to update threshold to $0.35
    const result = manager.setThreshold(0.35);

    // Must report failure
    expect(result.success).toBe(false);
    expect(result.error).toContain('Persistence failure');
    expect(result.error).toContain('EACCES');

    // Must retain previous confirmed threshold
    expect(result.thresholdUSDC).toBe(0.50);
    expect(result.thresholdCents).toBe(50);
    expect(manager.getThresholdUSDC()).toBe(0.50);
    expect(manager.getThresholdCents()).toBe(50);
    expect(manager.getFormattedThreshold()).toBe('$0.50 USDC');

    // Change listeners must NOT be called
    expect(listenerCallCount).toBe(0);
  });

  // 3. Historical Threshold Recording in SQLite (Survives persistence & retrieval)
  it('ensures evaluatedMinNetProfitUSDC survives SQLite persistence and subsequent record retrieval', () => {
    const { dbFile } = getUniqueTestFiles();
    const config = loadConfig();
    config.DB_PATH = dbFile;

    const repo = new ArbitrageRepository(config);

    const candidateId = `HISTORICAL-TEST-${Date.now()}`;
    const candidate: ArbitrageCandidate = {
      candidateId,
      routeName: 'Raydium WSOL -> Orca USDC',
      direction: 'USDC_TO_WSOL_TO_USDC',
      cycleType: '2_LEG',
      qualityLabel: 'SHADOW_QUALIFIED',
      optimalSizeUSDC: 100,
      inputAmountUSDC: 100_000_000n,
      leg1ExpectedOutWSOL: 500_000_000n,
      leg1ConservativeOutWSOL: 499_000_000n,
      leg2ExpectedOutUSDC: 101_000_000n,
      leg2ConservativeOutUSDC: 100_800_000n,
      expectedNetUSDC: '0.9770',
      minConservativeNetUSDC: '0.5270',
      status: 'QUALIFIED_SHADOW',
      rejectionReasons: [],
      leg1Quote: createValidQuote(),
      leg2Quote: createValidQuote(),
      costs: createValidCosts(),
      timestamp: Date.now(),
      slotGap: 1,
      quoteAgeMs: 45,
      competitionScore: 88,
      executionProbability: 'UNCALIBRATED',
      scoringBreakdown: {
        profitabilityScore: 30,
        capitalEfficiencyScore: 18,
        quoteFreshnessScore: 15,
        competitionPenalty: 0,
        complexityScore: 10,
        totalScore: 73,
        rationale: ['Test evaluation']
      },
      // Crucial field: evaluated with a $0.35 hurdle at execution time
      evaluatedMinNetProfitUSDC: 0.35
    };

    repo.saveCandidate(candidate);
    repo.flushSync();

    // Query back from SQLite via getTopOpportunities
    const topOpps = repo.getTopOpportunities(10);
    const foundInTop = topOpps.find(c => c.candidateId === candidateId);
    expect(foundInTop).toBeDefined();
    expect(foundInTop?.evaluatedMinNetProfitUSDC).toBe(0.35);

    // Query back from SQLite via getCandidate
    const fetched = repo.getCandidate(candidateId);
    expect(fetched).not.toBeNull();
    expect(fetched?.candidateId).toBe(candidateId);
    expect(fetched?.evaluatedMinNetProfitUSDC).toBe(0.35);
    expect(fetched?.scoringBreakdown?.totalScore).toBe(73);

    repo.close();
  });

  // 4. Actual Live HUD Telemetry & Status Polling
  it('provides live telemetry via GET /api/status showing STANDBY when scanner is absent, and ONLINE when connected', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });

    // A) When scanner is absent
    const hudWithoutScanner = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const infoA = await hudWithoutScanner.start();

    try {
      const resA = await makeHttpRequest(`http://127.0.0.1:${infoA.port}/api/status`, 'GET');
      expect(resA.statusCode).toBe(200);
      const dataA = JSON.parse(resA.body);
      expect(dataA.scannerStatus).toBe('STANDBY');
      expect(dataA.rpcStatus).toBe('STANDBY');
      expect(dataA.wsStatus).toBe('STANDBY');
      expect(dataA.solanaSlot).toBeNull();
      expect(dataA.thresholdUSDC).toBe(0.50);
    } finally {
      await hudWithoutScanner.stop();
    }

    // B) When scanner is connected
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    const hudWithScanner = new ProfitHudServer(manager, scanner, { port: 0, silent: true });
    const infoB = await hudWithScanner.start();

    try {
      const resB = await makeHttpRequest(`http://127.0.0.1:${infoB.port}/api/status`, 'GET');
      expect(resB.statusCode).toBe(200);
      const dataB = JSON.parse(resB.body);
      expect(dataB.scannerStatus).toBe('ONLINE');
      expect(dataB.thresholdUSDC).toBe(0.50);
      expect(dataB.activeShadowSignalsCount).toBe(0);
      expect(dataB.activeAllocatedCapitalUSDC).toBe(0);

      // Verify HTML dashboard includes telemetry card and 3-second polling
      const resHtml = await makeHttpRequest(`http://127.0.0.1:${infoB.port}/`, 'GET');
      expect(resHtml.statusCode).toBe(200);
      expect(resHtml.body).toContain('telemetryCard');
      expect(resHtml.body).toContain('telemetryScannerStatus');
      expect(resHtml.body).toContain('telemetrySlot');
      expect(resHtml.body).toContain('telemetryNetwork');
      expect(resHtml.body).toContain('setInterval(fetchTelemetry, 3000)');
    } finally {
      await hudWithScanner.stop();
      scanner.stop();
    }
  });

  // 5. Threshold Changes During Scanning
  it('updates candidate qualification and rechecks in real-time when threshold is updated during scanning', () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);
    const calculator = new ArbitrageProfitCalculator(config, manager);
    const tracker = scanner.getOpportunityTracker();

    // Set initial threshold $0.25
    manager.setThreshold(0.25);

    // Leg with minConservativeNet = +0.4000
    const leg1 = createValidQuote({
      poolId: 'test-pool-1',
      inAmount: 100_000_000n,
      outAmount: 500_000_000n,
      outputMint: CANONICAL_WSOL_MINT
    });
    const leg2 = createValidQuote({
      poolId: 'test-pool-2',
      inAmount: 500_000_000n,
      outAmount: 100_673_000n,
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT
    });
    const leg2Conservative = createValidQuote({
      poolId: 'test-pool-2',
      inAmount: 500_000_000n,
      outAmount: 100_773_673n,
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT
    });
    const costs = createValidCosts();

    const candidateAt25 = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      leg2ConservativeQuote: leg2Conservative,
      costs,
      currentSlot: 1000,
      wsConnected: true
    });

    expect(new Decimal(candidateAt25.minConservativeNetUSDC).gte(0.25)).toBe(true);
    expect(new Decimal(candidateAt25.minConservativeNetUSDC).lt(0.50)).toBe(true);
    expect(candidateAt25.status).toBe('QUALIFIED_SHADOW');
    expect(candidateAt25.evaluatedMinNetProfitUSDC).toBe(0.25);

    // Track active opportunity
    tracker.trackOpportunity(candidateAt25, 1000);
    expect(tracker.getAllActiveOpportunities()[0].status).toBe('QUALIFIED_SHADOW');

    // Elevate threshold to $0.50
    manager.setThreshold(0.50);

    // Immediately reclassified without restart
    expect(tracker.getAllActiveOpportunities()[0].status).toBe('REJECTED');

    // Future evaluation fails against $0.50 hurdle
    const candidateAt50 = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      leg2ConservativeQuote: leg2Conservative,
      costs,
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateAt50.status).toBe('CANDIDATE');
    expect(candidateAt50.rejectionReasons).toContain('LOW_CONSERVATIVE_NET');
    expect(candidateAt50.evaluatedMinNetProfitUSDC).toBe(0.50);

    scanner.stop();
  });

  // 6. Localhost Security: Origin and Host Enforcement (No Arbitrary CORS Reflection)
  it('strictly rejects non-localhost Origin and mismatched Host headers, never reflecting foreign origins in CORS', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const { port } = await hud.start();

    try {
      // A) Foreign Origin on OPTIONS: 403 Forbidden, no reflection
      const optionsRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'OPTIONS',
        undefined,
        { 'Origin': 'http://evil.com' }
      );
      expect(optionsRes.statusCode).toBe(403);
      expect(optionsRes.headers['access-control-allow-origin']).toBeUndefined();

      // B) Foreign Origin on POST /api/threshold: 403 Forbidden, no reflection
      const foreignPostRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'POST',
        JSON.stringify({ thresholdUSDC: 0.35 }),
        { 'Origin': 'http://attacker-site.com', 'Content-Type': 'application/json' }
      );
      expect(foreignPostRes.statusCode).toBe(403);
      expect(foreignPostRes.headers['access-control-allow-origin']).not.toBe('http://attacker-site.com');
      expect(manager.getThresholdUSDC()).toBe(0.50); // Unchanged

      // C) Mismatched Host header: 403 Forbidden
      const badHostRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'POST',
        JSON.stringify({ thresholdUSDC: 0.35 }),
        { 'Host': 'evil.com', 'Origin': `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
      );
      expect(badHostRes.statusCode).toBe(403);
      expect(manager.getThresholdUSDC()).toBe(0.50); // Unchanged

      // D) Valid local Origin & Host: 200 OK
      const validPostRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'POST',
        JSON.stringify({ thresholdUSDC: 0.35 }),
        { 'Origin': `http://127.0.0.1:${port}`, 'Host': `127.0.0.1:${port}`, 'Content-Type': 'application/json' }
      );
      expect(validPostRes.statusCode).toBe(200);
      expect(validPostRes.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${port}`);
      expect(manager.getThresholdUSDC()).toBe(0.35);
    } finally {
      await hud.stop();
    }
  });

  // 7. Trading Safety Invariants Protected
  it('confirms lowering profit threshold NEVER bypasses stale quote, excessive slot gap or unverified quote gates', () => {
    const { thresholdFile } = getUniqueTestFiles();
    const config = loadConfig();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    manager.setThreshold(0.20); // Lowest hurdle
    const calculator = new ArbitrageProfitCalculator(config, manager);

    // Stale quote (age > 2500ms default MAX_QUOTE_AGE_MS)
    const staleQuote = createValidQuote({ poolId: 'test-pool-1', timestamp: Date.now() - 10_000 });
    const normalQuote = createValidQuote({ poolId: 'test-pool-2' });
    const candidateStale = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: staleQuote,
      leg2Quote: normalQuote,
      costs: createValidCosts(),
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateStale.rejectionReasons).toContain('STALE_QUOTE');
    expect(candidateStale.status).toBe('STALE');

    // Slot gap > 10 (default MAX_SLOT_GAP)
    const candidateLag = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: createValidQuote({ poolId: 'test-pool-1', slot: 980 }),
      leg2Quote: createValidQuote({ poolId: 'test-pool-2', slot: 1000 }),
      costs: createValidCosts(),
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateLag.rejectionReasons).toContain('SLOT_MISMATCH');
    expect(candidateLag.status).toBe('REJECTED');

    // Unverified pool quote
    const unverifiedQuote = createValidQuote({ poolId: 'test-pool-1', isUnverified: true, unverifiedReason: 'MINT_MISMATCH' });
    const candidateUnverified = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: unverifiedQuote,
      leg2Quote: normalQuote,
      costs: createValidCosts(),
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateUnverified.rejectionReasons).toContain('QUOTE_UNVERIFIED');
    expect(candidateUnverified.status).toBe('UNSUPPORTED');
  });
});

/**
 * Helper to make synchronous-like HTTP request using Node built-in http
 */
function makeHttpRequest(
  urlStr: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Host': parsed.host,
          ...headers
        }
      },
      (res) => {
        let resBody = '';
        res.on('data', chunk => { resBody += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: resBody
          });
        });
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}
