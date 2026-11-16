import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { loadConfig } from '../src/config/index.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import fs from 'fs';
import path from 'path';

describe('SOLANABOT — Final Metric Integrity Correction Suite', () => {
  const testDir = path.join(process.cwd(), 'data', 'test_metric_integrity');

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
      dbFile: path.join(testDir, `test_scanner_${id}.db`),
      poolsFile: path.join(testDir, `test_pools_${id}.json`)
    };
  }

  // 1. Telemetry Defect 1: quoteProducingScannerUptimePercent vs quoteValidPercentage
  it('Uptime Integrity: quoteProducingScannerUptimePercent measures elapsed monitoring time and is NOT equal to quoteValidPercentage', () => {
    const { thresholdFile, dbFile, poolsFile } = getUniqueTestFiles();
    const config = loadConfig({
      DB_PATH: dbFile,
      DISCOVERED_POOLS_FILE: poolsFile,
      MAX_QUOTE_AGE_MS: '2500'
    });
    const thresholdManager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, thresholdManager);

    const now = Date.now();

    // Case A: Before any quotes are produced
    const initialStats = scanner.getQuoteProducingUptimeStats(now);
    expect(initialStats.quoteProducingUptimePercent).toBe(0);
    expect(initialStats.quoteValidEvaluations).toBe(0);
    expect(initialStats.quoteValidPercentage).toBe(0);
    expect(initialStats.lastValidQuoteTimestamp).toBeNull();

    // Case B: Quotes produced - simulate quote evaluation yield of 5% (5 valid quotes out of 100 total evaluations)
    // Over a 100-second session, valid quotes were actively produced during a continuous 80-second window
    (scanner as any).sessionStartTime = now - 100000; // 100s ago
    (scanner as any).auditMetrics.totalEvaluated = 100;
    (scanner as any).quoteValidEvaluationsCount = 5;

    // Simulate active quote production from T-90s to T-10s (fresh window of 80s)
    (scanner as any).isQuoteProducingActive = true;
    (scanner as any).currentQuoteProducingWindowStart = now - 90000;
    (scanner as any).lastValidQuoteTimestamp = now - 10000;

    const stats = scanner.getQuoteProducingUptimeStats(now);

    // quoteValidPercentage must reflect evaluation yield: 5 / 100 = 5.0%
    expect(stats.quoteValidPercentage).toBe(5.0);

    // quoteProducingUptimePercent must reflect active monitoring time: (now - 10s + 5s buffer - (now - 90s)) = 85s / 100s = 85.0%
    expect(stats.quoteProducingUptimePercent).toBe(85.0);

    // CRITICAL ASSERTION: The two metrics must NOT be forced to be equal!
    expect(stats.quoteProducingUptimePercent).not.toBe(stats.quoteValidPercentage);

    // HUD V2 Data must expose both separately
    const hud = scanner.getHudV2Data();
    expect(hud.performance.quoteValidPercentage).toBe(5.0);
    expect(hud.performance.quoteValidEvaluations).toBe(5);
    expect(hud.routeHealth.quoteProducingScannerUptimePercent).toBe(85.0);

    scanner.stop();
  });

  // 2. Telemetry Defect 2: Benchmark Coverage Counts Separation
  it('Coverage Breakdown: Reports all 8 metrics separately and NEVER subtracts account subscriptions from pool count', () => {
    const { thresholdFile, dbFile, poolsFile } = getUniqueTestFiles();
    const config = loadConfig({
      DB_PATH: dbFile,
      DISCOVERED_POOLS_FILE: poolsFile,
      MAX_WS_SUBSCRIPTIONS: '25'
    });
    const thresholdManager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, thresholdManager);

    // Populate mock pool registry with 56 pools
    const poolReg = scanner.getPoolRegistry();
    for (let i = 0; i < 56; i++) {
      poolReg.register({
        id: `PoolAccount_${i.toString().padStart(4, '0')}`,
        dex: i % 2 === 0 ? 'RAYDIUM_AMM' : 'ORCA_WHIRLPOOL',
        tokenA: 'So11111111111111111111111111111111111111112',
        tokenB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        reserveA: 1000000000n,
        reserveB: 200000000000n,
        feeBps: 25,
        isActive: true,
        verificationStatus: 'VERIFIED_DIRECT'
      });
    }

    const expectedTotalPools = poolReg.getAllPools().length;
    const expectedVerifiedPools = poolReg.getAllPools().filter(p => p.verificationStatus === 'VERIFIED_DIRECT').length;

    // Set monitored bundles and skipped bundles
    (scanner as any).monitoredPoolBundleCount = 8;
    (scanner as any).skippedPoolBundleCount = expectedTotalPools - 8;
    (scanner as any).subscribedAccounts = new Set<string>();
    for (let i = 0; i < 25; i++) {
      (scanner as any).subscribedAccounts.add(`Account_${i}`);
    }
    vi.spyOn((scanner as any).ws, 'getStats').mockReturnValue({
      confirmedSubscriptionCount: 25,
      rejectedSubscriptionCount: 0,
      subscriptionCount: 25,
      messagesTotal: 100,
      totalDowntimeMs: 0
    });

    const coverage = scanner.getCoverageBreakdown();

    // Verify all 8 fields exist and have correct types/values
    expect(coverage).toHaveProperty('registeredPools', expectedTotalPools);
    expect(coverage).toHaveProperty('onChainVerifiedPools', expectedVerifiedPools);
    expect(coverage).toHaveProperty('fullyMonitoredPoolBundles', 8);
    expect(coverage).toHaveProperty('confirmedAccountSubscriptions', 25);
    expect(coverage).toHaveProperty('skippedPoolBundles', expectedTotalPools - 8);
    expect(coverage).toHaveProperty('rejectedAccountSubscriptions', 0);
    expect(coverage).toHaveProperty('poolsLackingFreshLiveData');
    expect(coverage).toHaveProperty('routesGenuinelyReady');

    // CRITICAL INVARIANT: Total pool count is equal to monitored bundles + skipped bundles
    expect(coverage.fullyMonitoredPoolBundles + coverage.skippedPoolBundles).toBe(coverage.registeredPools);

    // CRITICAL ASSERTION: Subscriptions (25) are NOT subtracted from pools
    expect(coverage.skippedPoolBundles).not.toBe(expectedTotalPools - 25);

    scanner.stop();
  });
});
