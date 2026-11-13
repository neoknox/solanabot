import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import http from 'http';
import {
  ProfitThresholdManager,
  VALID_PROFIT_THRESHOLDS_CENTS,
  DEFAULT_PROFIT_THRESHOLD_CENTS
} from '../src/profit/profitThresholdManager.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { loadConfig, CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT } from '../src/config/index.js';
import { SwapQuote, CostBreakdown } from '../src/types/index.js';

describe('Phase 1.3: Profit Threshold HUD & Runtime Control Suite', () => {
  const testDataDir = path.join(process.cwd(), 'data', 'test_threshold');
  const testFile = path.join(testDataDir, 'test_profit_threshold.json');

  beforeEach(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

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
      totalCostsUSDC: '0.023000', // net consumed + contingency
      solPriceUSDC: '200.00',
      recoverableDepositUSDC: '0.000000',
      consumedCostUSDC: '0.003000',
      potentialLossOnFailureUSDC: '0.003000',
      assumptions: ['deterministic test cost model'],
      ...overrides
    };
  }

  // 1. Initial State & Defaults
  it('initializes to authoritative default $0.50 USDC (50 cents) on clean start', () => {
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    expect(manager.getThresholdUSDC()).toBe(0.50);
    expect(manager.getThresholdCents()).toBe(50);
    expect(manager.getThresholdDecimal().equals(new Decimal(0.50))).toBe(true);
    expect(manager.getFormattedThreshold()).toBe('$0.50 USDC');
    expect(fs.existsSync(testFile)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(saved.thresholdUSDC).toBe(0.50);
    expect(saved.cents).toBe(50);
    expect(saved.mode).toBe('READ-ONLY / SHADOW MODE');
  });

  // 2. Acceptance of all 11 valid steps
  it('accepts each valid $0.05 step between $0.20 and $0.70 USDC (integer cents 20..70)', () => {
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });

    for (const cents of VALID_PROFIT_THRESHOLDS_CENTS) {
      const usdc = cents / 100;
      const res = manager.setThreshold(usdc);
      expect(res.success).toBe(true);
      expect(res.thresholdCents).toBe(cents);
      expect(res.thresholdUSDC).toBe(usdc);
      expect(manager.getThresholdCents()).toBe(cents);
      expect(manager.getThresholdUSDC()).toBe(usdc);
      expect(manager.getThresholdDecimal().equals(new Decimal(cents).div(100))).toBe(true);
    }
  });

  // 3. Strict rejection of invalid values
  it('strictly rejects $0.19, $0.21, $0.71, negative, fractional and malformed payloads without altering running setting', () => {
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    expect(manager.getThresholdUSDC()).toBe(0.50);

    const invalidInputs = [
      0.19,             // below min $0.20
      0.21,             // non-step increment ($0.01)
      0.71,             // above max $0.70
      0.49,             // non-step increment
      0.555,            // fractional cents
      -0.50,            // negative
      0,                // zero
      NaN,              // not a number
      Infinity,         // non-finite
      '',               // empty string
      'not-a-number',   // non-numeric string
      null,             // null
      undefined,        // undefined
      true,             // boolean
      [],               // array
      {}                // object
    ];

    for (const invalid of invalidInputs) {
      const res = manager.setThreshold(invalid as any);
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      // Running setting remains completely unchanged at 0.50
      expect(manager.getThresholdUSDC()).toBe(0.50);
      expect(manager.getThresholdCents()).toBe(50);
    }
  });

  // 4. Exact boundary qualification: $0.40 fails at $0.50, qualifies at $0.40, qualifies at $0.20
  it('demonstrates exact boundary qualification: conservative net $0.40 fails at $0.50 but qualifies at $0.40 and $0.20', () => {
    const config = loadConfig();
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    const calculator = new ArbitrageProfitCalculator(config, manager);

    // Initial input: 100.00 USDC
    // Output: 100.673000 USDC
    // Total costs: 0.023000 USDC
    // Safety buffer: 0.250000 USDC
    // minConservativeNetUSDC = 100.673000 - 100.00 - 0.023000 - 0.250000 = +0.400000 USDC exactly
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
      outAmount: 100_773_673n, // minus 100_673n slippage = 100_673_000n conservative units
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT
    });
    const costs = createValidCosts();

    // A) At default $0.50 hurdle: $0.40 is strictly less than $0.50 -> REJECTED (LOW_CONSERVATIVE_NET)
    manager.setThreshold(0.50);
    const candidateAt50 = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      leg2ConservativeQuote: leg2Conservative,
      costs,
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateAt50.minConservativeNetUSDC).toBe('0.4000');
    expect(candidateAt50.status).toBe('CANDIDATE'); // Expected net positive, but rejected by conservative hurdle
    expect(candidateAt50.rejectionReasons).toContain('LOW_CONSERVATIVE_NET');
    expect(candidateAt50.evaluatedMinNetProfitUSDC).toBe(0.50);

    // B) At $0.40 hurdle: exact boundary ($0.4000 >= $0.40) -> QUALIFIED_SHADOW
    manager.setThreshold(0.40);
    const candidateAt40 = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      leg2ConservativeQuote: leg2Conservative,
      costs,
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateAt40.minConservativeNetUSDC).toBe('0.4000');
    expect(candidateAt40.status).toBe('QUALIFIED_SHADOW');
    expect(candidateAt40.qualityLabel).toBe('SHADOW_QUALIFIED');
    expect(candidateAt40.rejectionReasons).toHaveLength(0);
    expect(candidateAt40.evaluatedMinNetProfitUSDC).toBe(0.40);

    // C) At $0.20 hurdle: $0.4000 >= $0.20 -> QUALIFIED_SHADOW
    manager.setThreshold(0.20);
    const candidateAt20 = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      leg2ConservativeQuote: leg2Conservative,
      costs,
      currentSlot: 1000,
      wsConnected: true
    });
    expect(candidateAt20.status).toBe('QUALIFIED_SHADOW');
    expect(candidateAt20.evaluatedMinNetProfitUSDC).toBe(0.20);
  });

  // 5. Shared authoritative owner between Calculator and Scanner without restart
  it('shares ONE authoritative runtime threshold across calculator, scanner and survival rechecks immediately', () => {
    const config = loadConfig();
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    expect(scanner.getProfitThresholdManager().getThresholdUSDC()).toBe(0.50);

    // Update threshold to $0.35 via manager
    manager.setThreshold(0.35);

    expect(scanner.getProfitThresholdManager().getThresholdUSDC()).toBe(0.35);
    expect(scanner.getProfitThresholdManager().getThresholdCents()).toBe(35);
    expect(scanner.getProfitThresholdManager().getThresholdDecimal().equals(new Decimal(0.35))).toBe(true);
  });

  // 6. Persistence across restarts and corrupt file recovery
  it('persists selection across restarts, and safely recovers to $0.50 with warning on corrupt file', () => {
    // Session 1: change to $0.65
    const session1 = new ProfitThresholdManager({ filePath: testFile, silent: true });
    session1.setThreshold(0.65);
    expect(session1.getThresholdUSDC()).toBe(0.65);

    // Session 2: reloads $0.65 from disk
    const session2 = new ProfitThresholdManager({ filePath: testFile, silent: true });
    expect(session2.getThresholdUSDC()).toBe(0.65);
    expect(session2.getThresholdCents()).toBe(65);

    // Corrupt file simulation: write invalid JSON
    fs.writeFileSync(testFile, '{"thresholdUSDC": 999, "invalid": true', 'utf-8');

    // Session 3: corrupt file triggers fallback to $0.50 default
    const session3 = new ProfitThresholdManager({ filePath: testFile, silent: true });
    expect(session3.getThresholdUSDC()).toBe(0.50);
    expect(session3.getThresholdCents()).toBe(50);
  });

  // 7. Active shadow signal invalidation / clearance on threshold elevation
  it('reclassifies active shadow signals that no longer meet an increased hurdle so stale signals never linger', () => {
    const config = loadConfig();
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);
    const tracker = scanner.getOpportunityTracker();

    // Start with low threshold $0.25
    manager.setThreshold(0.25);

    // Create candidate with conservative net $0.30
    const candidate: any = {
      candidateId: 'ARB-TEST-001',
      routeName: 'Raydium -> Orca',
      inputAmountUSDC: 100_000_000n,
      optimalSizeUSDC: 100,
      minConservativeNetUSDC: '0.3000',
      status: 'QUALIFIED_SHADOW',
      timestamp: Date.now(),
      stateVersion: 'slot-1000',
      leg1Quote: { poolId: 'pool-a' },
      leg2Quote: { poolId: 'pool-b' }
    };

    tracker.trackOpportunity(candidate, 1000);
    expect(tracker.getAllActiveOpportunities()[0].status).toBe('QUALIFIED_SHADOW');
    expect(tracker.getLifecycleStats().activeOpportunitiesCount).toBe(1);

    // Now elevate hurdle to $0.50: $0.30 is below $0.50 -> MUST reclassify to REJECTED
    manager.setThreshold(0.50);

    const activeRecords = tracker.getAllActiveOpportunities();
    expect(activeRecords[0].status).toBe('REJECTED');
    expect(tracker.getLifecycleStats().activeOpportunitiesCount).toBe(0);
    expect(tracker.getActiveAllocatedCapital()).toBe(0);
  });

  // 8. Localhost HTTP HUD server & Origin security
  it('serves HUD status and slider endpoints strictly on 127.0.0.1 and enforces Origin validation on POST', async () => {
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    // Use an ephemeral port (0) to prevent port collisions during tests
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const { port, host } = await hud.start();

    expect(host).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);

    try {
      // A) GET / serves HTML with READ-ONLY / SHADOW MODE badge
      const getHtmlRes = await makeHttpRequest(`http://127.0.0.1:${port}/`, 'GET');
      expect(getHtmlRes.statusCode).toBe(200);
      expect(getHtmlRes.body).toContain('READ-ONLY / SHADOW MODE');
      expect(getHtmlRes.body).toContain('thresholdSlider');
      expect(getHtmlRes.body).toContain('$0.50 USDC');

      // B) GET /api/threshold returns active setting
      const getApiRes = await makeHttpRequest(`http://127.0.0.1:${port}/api/threshold`, 'GET');
      expect(getApiRes.statusCode).toBe(200);
      const thresholdJson = JSON.parse(getApiRes.body);
      expect(thresholdJson.success).toBe(true);
      expect(thresholdJson.thresholdUSDC).toBe(0.50);
      expect(thresholdJson.thresholdCents).toBe(50);
      expect(thresholdJson.mode).toBe('READ-ONLY / SHADOW MODE');

      // C) POST /api/threshold with foreign Origin is REJECTED with 403 Forbidden
      const foreignPostRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'POST',
        JSON.stringify({ thresholdUSDC: 0.35 }),
        { 'Origin': 'http://malicious-site.com', 'Content-Type': 'application/json' }
      );
      expect(foreignPostRes.statusCode).toBe(403);
      expect(manager.getThresholdUSDC()).toBe(0.50); // unchanged

      // D) POST /api/threshold with local Origin succeeds and updates live setting
      const localPostRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'POST',
        JSON.stringify({ thresholdUSDC: 0.35 }),
        { 'Origin': `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
      );
      expect(localPostRes.statusCode).toBe(200);
      const postJson = JSON.parse(localPostRes.body);
      expect(postJson.success).toBe(true);
      expect(postJson.thresholdUSDC).toBe(0.35);
      expect(postJson.thresholdCents).toBe(35);
      expect(manager.getThresholdUSDC()).toBe(0.35);

      // E) POST /api/threshold with invalid value returns 400 and preserves prior value
      const invalidPostRes = await makeHttpRequest(
        `http://127.0.0.1:${port}/api/threshold`,
        'POST',
        JSON.stringify({ thresholdUSDC: 0.21 }),
        { 'Origin': `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
      );
      expect(invalidPostRes.statusCode).toBe(400);
      const invalidJson = JSON.parse(invalidPostRes.body);
      expect(invalidJson.success).toBe(false);
      expect(invalidJson.error).toBeDefined();
      expect(manager.getThresholdUSDC()).toBe(0.35); // retained prior value
    } finally {
      await hud.stop();
    }
  });

  // 9. Safety Invariants Unchanged
  it('confirms lowering the threshold NEVER bypasses safety buffer, excessive price impact or unverified routes', () => {
    const config = loadConfig();
    const manager = new ProfitThresholdManager({ filePath: testFile, silent: true });
    manager.setThreshold(0.20); // lowest allowed threshold
    const calculator = new ArbitrageProfitCalculator(config, manager);

    // Excessive price impact quote (e.g. 500 bps > MAX_PRICE_IMPACT_BPS 200)
    const highImpactQuote = createValidQuote({ poolId: 'test-pool-1', priceImpactBps: 500 });
    const normalQuote = createValidQuote({
      poolId: 'test-pool-2',
      inAmount: 500_000_000n,
      outAmount: 105_000_000n,
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT
    });
    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100_000_000n,
      leg1Quote: highImpactQuote,
      leg2Quote: normalQuote,
      costs: createValidCosts(),
      currentSlot: 1000,
      wsConnected: true
    });

    expect(candidate.rejectionReasons).toContain('EXCESSIVE_PRICE_IMPACT');
    expect(candidate.status).toBe('REJECTED');
    expect(candidate.qualityLabel).toBe('INVALID');
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
