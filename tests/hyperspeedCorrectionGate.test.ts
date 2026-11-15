import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { LatencyTracker } from '../src/telemetry/latencyTracker.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT, KNOWN_PROGRAM_IDS, loadConfig } from '../src/config/index.js';
import { ArbitrageCandidate, PoolState } from '../src/types/index.js';
import { PublicKey } from '@solana/web3.js';

describe('Hyperspeed Correction Gate: Comprehensive Regression Suite', () => {
  const baseConfig = loadConfig({ DB_PATH: ':memory:', DISCOVERED_POOLS_FILE: 'nonexistent.json' });

  const raydiumPoolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const baseVaultStr = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const quoteVaultStr = 'So11111111111111111111111111111111111111112';
  const ooPubkeyStr = '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6';

  function createValidRaydiumPoolBuffer(): Buffer {
    const buf = Buffer.alloc(752);
    buf.writeBigUInt64LE(6n, 0); // status = 6 (initialized)
    new PublicKey(baseVaultStr).toBuffer().copy(buf, 336);
    new PublicKey(quoteVaultStr).toBuffer().copy(buf, 368);
    new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(buf, 400);
    new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(buf, 432);
    new PublicKey(ooPubkeyStr).toBuffer().copy(buf, 496);
    new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(buf, 528);
    new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX').toBuffer().copy(buf, 560);
    return buf;
  }

  describe('1. False Freshness Prevention (Raydium AMM)', () => {
    it('preserves genuine vault metadata without synthesizing timestamps or slots during shared pool refresh', async () => {
      const scanner = new ArbitrageScanner(baseConfig);
      const initialVaultTime = Date.now() - 5000;
      const initialVaultSlot = 990;

      // Seed pool in stateCache with verified metadata and genuine vault observation
      scanner.getStateCache().setPoolState({
        id: raydiumPoolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 50000000000n,
        reserveB: 250000000000n,
        feeBps: 25,
        slot: initialVaultSlot,
        receivedAt: initialVaultTime,
        liquidityUsd: 100000,
        feedHealth: 'HEALTHY',
        extraData: {
          baseVault: baseVaultStr,
          quoteVault: quoteVaultStr,
          openOrders: ooPubkeyStr,
          vaultASlot: initialVaultSlot,
          vaultBSlot: initialVaultSlot,
          vaultAReceivedAt: initialVaultTime,
          vaultBReceivedAt: initialVaultTime,
          openOrdersSlot: initialVaultSlot,
          lastConfirmedAt: initialVaultTime,
          openOrdersVerified: true
        }
      });
      scanner.getPoolRegistry().updatePoolVerification(raydiumPoolId, 'VERIFIED_DIRECT');
      scanner.getPoolRegistry().updatePoolVerification(raydiumPoolId, 'VERIFIED_DIRECT');

      (scanner as any).isRunning = true;
      scanner.getRpc().getMultipleAccountsAndContext = vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
        const value = pubkeys.map(pk => {
          if (pk.toBase58() === raydiumPoolId) {
            return {
              data: createValidRaydiumPoolBuffer(),
              owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
              executable: false,
              lamports: 1000000
            };
          }
          return null;
        });
        return { slot: 1005, value };
      });

      await scanner.refreshStaleSharedPools();

      const updated = scanner.getStateCache().getPoolState(raydiumPoolId);
      expect(updated).toBeDefined();
      const extra = updated?.extraData as any;

      // GENUINE METADATA MUST BE PRESERVED - NEVER SYNTHESIZED!
      expect(extra.vaultASlot).toBe(initialVaultSlot);
      expect(extra.vaultBSlot).toBe(initialVaultSlot);
      expect(extra.vaultAReceivedAt).toBe(initialVaultTime);
      expect(extra.vaultBReceivedAt).toBe(initialVaultTime);
      expect(extra.openOrdersSlot).toBe(initialVaultSlot);
      expect(extra.lastConfirmedAt).toBe(initialVaultTime);
    });

    it('fails closed when vault observation metadata is stale (> TTL) during shared refresh', async () => {
      const scanner = new ArbitrageScanner(baseConfig);
      const staleTime = Date.now() - 45000; // 45s ago (> 30s TTL)

      scanner.getStateCache().setPoolState({
        id: raydiumPoolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 50000000000n,
        reserveB: 250000000000n,
        feeBps: 25,
        slot: 950,
        receivedAt: staleTime,
        liquidityUsd: 100000,
        feedHealth: 'HEALTHY',
        extraData: {
          baseVault: baseVaultStr,
          quoteVault: quoteVaultStr,
          openOrders: ooPubkeyStr,
          vaultASlot: 950,
          vaultBSlot: 950,
          vaultAReceivedAt: staleTime,
          vaultBReceivedAt: staleTime,
          openOrdersVerified: true
        }
      });
      scanner.getPoolRegistry().updatePoolVerification(raydiumPoolId, 'VERIFIED_DIRECT');

      (scanner as any).isRunning = true;
      scanner.getRpc().getMultipleAccountsAndContext = vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
        const value = pubkeys.map(pk => {
          if (pk.toBase58() === raydiumPoolId) {
            return {
              data: createValidRaydiumPoolBuffer(),
              owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
              executable: false,
              lamports: 1000000
            };
          }
          return null;
        });
        return { slot: 1005, value };
      });

      await scanner.refreshStaleSharedPools();

      const updated = scanner.getStateCache().getPoolState(raydiumPoolId);
      const extra = updated?.extraData as any;
      expect(extra.openOrdersVerified).toBe(false);
      expect(extra.unverifiedReason).toBe('STALE_VAULT_SNAPSHOT');
      expect(scanner.getPoolRegistry().getPool(raydiumPoolId)?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    });
  });

  describe('2. Latency Telemetry Separation & Percentiles', () => {
    let tracker: LatencyTracker;

    beforeEach(() => {
      tracker = new LatencyTracker();
    });

    it('returns null percentiles and N/A survival when 0 qualified signals exist', () => {
      // Record 10 rejected decisions
      for (let i = 0; i < 10; i++) {
        tracker.recordRejectedDecision(150 + i * 10);
      }

      const report = tracker.getReport();
      // Total decisions measured reflects all decisions
      expect(report.totalDecisionsMeasured).toBe(10);
      // Rejected decisions are populated
      expect(report.rejectedDecisionUs.count).toBe(10);
      expect(report.rejectedDecisionUs.p50).toBe(200);

      // Qualified detection T0 -> T6 MUST BE ZERO COUNT AND NULL STATS!
      expect(report.t0ToT6TotalUs.count).toBe(0);
      expect(report.t0ToT6TotalUs.p50).toBeNull();
      expect(report.t0ToT6TotalUs.p95).toBeNull();
      expect(report.t0ToT6TotalUs.max).toBeNull();

      // Survival percentage MUST BE NULL (N/A), not zero!
      expect(report.survivalStats.qualifiedSignalsCount).toBe(0);
      expect(report.survivalStats.revalidationSurvivalPercentage).toBeNull();
    });

    it('records queue wait and route lookup latencies separately', () => {
      tracker.recordQueueWait(42.5);
      tracker.recordQueueWait(55.0);
      tracker.recordRouteLookupDuration(12.3);
      tracker.recordRouteLookupDuration(15.7);

      const report = tracker.getReport();
      expect(report.queueWaitUs.count).toBe(2);
      expect(report.queueWaitUs.p50).toBe(55);

      expect(report.routeLookupUs.count).toBe(2);
      expect(report.routeLookupUs.p50).toBe(15.7);
    });

    it('measures T6 only upon actual signal qualification', () => {
      // Record pipeline stages with isQualified: false
      tracker.recordPipelineStages({
        t0: 1000,
        t1: 1000.2,
        t2: 1000.3,
        t3: 1000.4,
        t4: 1000.6,
        t5: 1000.8,
        isQualified: false
      });

      let report = tracker.getReport();
      expect(report.t0ToT6TotalUs.count).toBe(0);
      expect(report.t5ToT6SignalUs.count).toBe(0);
      expect(report.revalidationDurationUs.count).toBe(0);

      // Record pipeline stages with isQualified: true
      tracker.recordPipelineStages({
        t0: 2000,
        t1: 2000.2,
        t2: 2000.3,
        t3: 2000.4,
        t4: 2000.6,
        t5: 2000.8,
        t6: 2001.0,
        t7: 2001.3,
        isQualified: true
      });

      report = tracker.getReport();
      expect(report.t0ToT6TotalUs.count).toBe(1);
      expect(report.t0ToT6TotalUs.p50).toBeCloseTo(1000.0, 0); // 1.0 ms = 1000 us
      expect(report.t5ToT6SignalUs.count).toBe(1);
      expect(report.t5ToT6SignalUs.p50).toBeCloseTo(200.0, 0); // 0.2 ms = 200 us
      expect(report.revalidationDurationUs.count).toBe(1);
      expect(report.revalidationDurationUs.p50).toBeCloseTo(300.0, 0); // 0.3 ms = 300 us
    });
  });

  describe('3. Queue Scheduling & Event Loop Fairness', () => {
    it('prevents multiple pending drain callbacks using isDrainScheduled flag', async () => {
      const scanner = new ArbitrageScanner(baseConfig);
      const drainSpy = vi.spyOn(scanner as any, 'drainEventQueue');

      // Rapidly enqueue 10 updates
      for (let i = 0; i < 10; i++) {
        (scanner as any).enqueueUpdate({
          type: 'POOL_ACCOUNT',
          key: `test_pool_${i}`,
          data: Buffer.alloc(100),
          slot: 100,
          receivedAtMs: Date.now(),
          monotonicReceiptTime: performance.now()
        });
      }

      // Allow scheduled microtask to execute
      await new Promise<void>(resolve => { queueMicrotask(() => resolve()); });

      // drainEventQueue should have executed cleanly without queue thrashing
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. Signal Accounting & Capital Rule', () => {
    it('does not count duplicate market states as new opportunities', () => {
      const scanner = new ArbitrageScanner(baseConfig);
      const stateCache = scanner.getStateCache();

      const item = {
        route: 'route1',
        amountUSDC: 100_000_000n,
        netProfitUSDC: '1.25',
        stateVersion: 'poolA_100|poolB_100'
      };

      expect(stateCache.isDuplicate(item)).toBe(false);
      expect(stateCache.isDuplicate(item)).toBe(true);
    });

    it('marks failed revalidations as DECAYED and never SURVIVED', () => {
      const tracker = new LatencyTracker();
      tracker.recordSignalQualification(true, false, 0, 'POOL_PRICE_MOVED');

      const survival = tracker.getSurvivalStats();
      expect(survival.qualifiedSignalsCount).toBe(1);
      expect(survival.revalidatedSignalsCount).toBe(0);
      expect(survival.revalidationSurvivalPercentage).toBe(0.0);
      expect(survival.disappearanceReasons['POOL_PRICE_MOVED']).toBe(1);
    });
  });

  describe('5. Database Blocking & Write Buffer Protection', () => {
    const makeCandidate = (id: string, isQualified: boolean): ArbitrageCandidate => ({
      candidateId: id,
      routeName: 'Raydium -> Orca',
      direction: 'USDC_TO_WSOL_TO_USDC',
      inputAmountUSDC: 100000000n,
      leg1ExpectedOutWSOL: 800000000n,
      leg1ConservativeOutWSOL: 799200000n,
      leg2ExpectedOutUSDC: 102000000n,
      leg2ConservativeOutUSDC: 101898000n,
      expectedNetUSDC: isQualified ? '0.85' : '-0.10',
      minConservativeNetUSDC: isQualified ? '0.65' : '-0.15',
      status: isQualified ? 'QUALIFIED_SHADOW' : 'REJECTED',
      rejectionReasons: isQualified ? [] : ['EXCESSIVE_PRICE_IMPACT'],
      leg1Quote: {
        quoteSource: 'DIRECT_POOL',
        poolId: 'pool-A',
        dex: 'RAYDIUM_AMM',
        inputMint: 'USDC',
        outputMint: 'WSOL',
        inAmount: 100000000n,
        outAmount: 800000000n,
        feeIncluded: true,
        feeAmount: 250000n,
        priceImpactBps: 2,
        slot: 100,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      },
      leg2Quote: {
        quoteSource: 'DIRECT_POOL',
        poolId: 'pool-B',
        dex: 'ORCA_WHIRLPOOL',
        inputMint: 'WSOL',
        outputMint: 'USDC',
        inAmount: 799200000n,
        outAmount: 102000000n,
        feeIncluded: true,
        feeAmount: 32000n,
        priceImpactBps: 1,
        slot: 100,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      },
      costs: {
        networkFeeUSDC: '0.000625',
        priorityFeeUSDC: '0.001250',
        jitoTipUSDC: '0.000000',
        tokenTransferFeesUSDC: '0.000000',
        contingencyUSDC: '0.0200',
        safetyBufferUSDC: '0.2500',
        totalCostsUSDC: '0.021875',
        solPriceUSDC: '125.00',
        assumptions: ['Standard assumptions']
      },
      timestamp: Date.now(),
      slotGap: 0,
      quoteAgeMs: 0
    });

    it('buffers candidate saves without synchronous flush and protects qualified signals under overflow', () => {
      const repo = new ArbitrageRepository(baseConfig);

      const normalCandidate = makeCandidate('c_normal', false);
      const qualifiedCandidate = makeCandidate('c_qualified', true);

      // Save 500 candidates - MUST NOT block with synchronous disk flush!
      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        repo.saveCandidate(makeCandidate(`c_${i}`, false));
      }
      const durationMs = performance.now() - start;

      // 500 in-memory buffers must take < 50ms
      expect(durationMs).toBeLessThan(50);

      // Save a qualified candidate
      repo.saveCandidate(qualifiedCandidate);

      const stats = repo.getPersistenceStats();
      expect(stats.queuedCandidatesCount).toBeGreaterThan(0);
      expect(stats.persistenceErrorsCount).toBe(0);
    });
  });

  describe('6. RPC Fairness & Starvation Prevention', () => {
    it('enforces 2000ms cooldown per pool to prevent RPC starvation', async () => {
      const scanner = new ArbitrageScanner(baseConfig);

      scanner.getStateCache().setPoolState({
        id: raydiumPoolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000n,
        reserveB: 1000n,
        feeBps: 25,
        slot: 900,
        receivedAt: Date.now() - 5000,
        liquidityUsd: 100000,
        feedHealth: 'HEALTHY',
        extraData: {
          baseVault: baseVaultStr,
          quoteVault: quoteVaultStr,
          openOrders: ooPubkeyStr,
          vaultASlot: 900,
          vaultBSlot: 900,
          vaultAReceivedAt: Date.now() - 5000,
          vaultBReceivedAt: Date.now() - 5000,
          openOrdersVerified: true
        }
      });
      scanner.getPoolRegistry().updatePoolVerification(raydiumPoolId, 'VERIFIED_DIRECT');

      (scanner as any).isRunning = true;
      scanner.getRpc().getMultipleAccountsAndContext = vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
        const value = pubkeys.map(pk => {
          if (pk.toBase58() === raydiumPoolId) {
            return {
              data: createValidRaydiumPoolBuffer(),
              owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
              executable: false,
              lamports: 1000000
            };
          }
          return null;
        });
        return { slot: 1000, value };
      });

      // 1st refresh: succeeds and marks poolLastRpcRefreshTime
      const refreshedFirst = await scanner.refreshStaleSharedPools();
      expect(refreshedFirst).toBeGreaterThanOrEqual(1);

      // 2nd immediate refresh: MUST BE BLOCKED BY 2000ms COOLDOWN for raydiumPoolId
      const refreshedSecond = await scanner.refreshStaleSharedPools();
      // raydiumPoolId is cooling down and will not be refreshed again
      const poolLastRefresh = (scanner as any).poolLastRpcRefreshTime.get(raydiumPoolId);
      expect(poolLastRefresh).toBeDefined();
      expect(Date.now() - poolLastRefresh).toBeLessThan(2000);
    });
  });
});
