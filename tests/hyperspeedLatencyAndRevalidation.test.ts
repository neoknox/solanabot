import { describe, it, expect, beforeEach } from 'vitest';
import { LatencyTracker } from '../src/telemetry/latencyTracker.js';
import { RouteIndex, IndexedDirectedRoute } from '../src/scanner/routeIndex.js';
import { CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT } from '../src/config/index.js';

describe('Project Hyperspeed: Multi-Stage Telemetry, Prevalidation & Revalidation Suite', () => {
  describe('1. Multi-Stage Pipeline Latency Tracking (T0..T7)', () => {
    let tracker: LatencyTracker;

    beforeEach(() => {
      tracker = new LatencyTracker();
    });

    it('records high-precision monotonic pipeline stages correctly', () => {
      const t0 = 1000.0;
      const t1 = 1000.5; // +500 us (decode)
      const t2 = 1000.7; // +200 us (cache)
      const t3 = 1000.9; // +200 us (routes)
      const t4 = 1001.2; // +300 us (quoting)
      const t5 = 1001.4; // +200 us (calc)
      const t6 = 1001.6; // +200 us (signal) => total T0->T6 = 1600 us (1.6 ms)
      const t7 = 1002.0; // +400 us (revalidation)

      tracker.recordPipelineStages({ t0, t1, t2, t3, t4, t5, t6, t7 });

      const report = tracker.getReport();
      expect(report.t0ToT6TotalUs.p50).toBeCloseTo(1600, 0);
      expect(report.t0ToT1DecodeUs.p50).toBeCloseTo(500, 0);
      expect(report.t1ToT2CacheUs.p50).toBeCloseTo(200, 0);
      expect(report.t2ToT3RoutesUs.p50).toBeCloseTo(200, 0);
      expect(report.t3ToT4QuotingUs.p50).toBeCloseTo(300, 0);
      expect(report.t4ToT5CalcUs.p50).toBeCloseTo(200, 0);
      expect(report.t5ToT6SignalUs.p50).toBeCloseTo(200, 0);
      expect(report.revalidationDurationUs.p50).toBeCloseTo(400, 0);
    });

    it('tracks survival statistics and disappearance reasons', () => {
      // Signal 1: Survived with $0.45 profit
      tracker.recordSignalQualification(true, true, 0.45);
      // Signal 2: Survived with $0.35 profit
      tracker.recordSignalQualification(true, true, 0.35);
      // Signal 3: Decayed due to POOL_PRICE_MOVED
      tracker.recordSignalQualification(true, false, 0, 'POOL_PRICE_MOVED');
      // Signal 4: Decayed due to QUOTE_EXPIRED
      tracker.recordSignalQualification(true, false, 0, 'QUOTE_EXPIRED');

      const survival = tracker.getSurvivalStats();
      expect(survival.qualifiedSignalsCount).toBe(4);
      expect(survival.revalidatedSignalsCount).toBe(2);
      expect(survival.revalidationSurvivalPercentage).toBe(50.0);
      expect(survival.accumulatedConservativeNetUSDC).toBeCloseTo(0.80, 2);
      expect(survival.disappearanceReasons['POOL_PRICE_MOVED']).toBe(1);
      expect(survival.disappearanceReasons['QUOTE_EXPIRED']).toBe(1);
    });
  });

  describe('2. Prevalidated Route Dependencies & Invalidation', () => {
    const mockPools = [
      { id: 'poolA', dex: 'RAYDIUM_AMM' as const, tokenAMint: CANONICAL_USDC_MINT, tokenBMint: CANONICAL_WSOL_MINT, feeBps: 25, isVerified: true, verificationStatus: 'VERIFIED_DIRECT' as const, programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' },
      { id: 'poolB', dex: 'ORCA_WHIRLPOOL' as const, tokenAMint: CANONICAL_USDC_MINT, tokenBMint: CANONICAL_WSOL_MINT, feeBps: 30, isVerified: true, verificationStatus: 'VERIFIED_DIRECT' as const, programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }
    ];

    let routeIndex: RouteIndex;

    beforeEach(() => {
      routeIndex = new RouteIndex(mockPools);
    });

    it('caches and invalidates prevalidatedConfig on pool updates', () => {
      const routes = routeIndex.getAllRoutes();
      expect(routes.length).toBeGreaterThan(0);
      const route = routes[0];

      // Attach prevalidation config
      route.prevalidatedConfig = {
        isValid: true,
        leg0: {
          poolId: 'poolA',
          dex: 'RAYDIUM_AMM',
          inputMint: CANONICAL_USDC_MINT,
          outputMint: CANONICAL_WSOL_MINT,
          direction: 'A_TO_B',
          slippageBps: 20
        },
        leg1: {
          poolId: 'poolB',
          dex: 'ORCA_WHIRLPOOL',
          inputMint: CANONICAL_WSOL_MINT,
          outputMint: CANONICAL_USDC_MINT,
          direction: 'B_TO_A',
          slippageBps: 20
        },
        requiresAtaSetup: true
      };

      expect(route.prevalidatedConfig).toBeDefined();

      // Trigger pool status update -> must invalidate cached prevalidation
      routeIndex.updatePoolStatus('poolA', 'QUOTE_UNVERIFIED');
      expect(route.prevalidatedConfig).toBeUndefined();
    });

    it('invalidates all prevalidated configs upon WebSocket reconnect', () => {
      const routes = routeIndex.getAllRoutes();
      expect(routes.length).toBeGreaterThan(0);
      const route = routes[0];

      route.prevalidatedConfig = {
        isValid: true,
        leg0: { poolId: 'poolA', dex: 'RAYDIUM_AMM', inputMint: '', outputMint: '', direction: 'A_TO_B', slippageBps: 20 },
        leg1: { poolId: 'poolB', dex: 'ORCA_WHIRLPOOL', inputMint: '', outputMint: '', direction: 'A_TO_B', slippageBps: 20 },
        requiresAtaSetup: false
      };

      expect(route.prevalidatedConfig).toBeDefined();
      routeIndex.invalidateAllPrevalidatedRoutes();
      expect(route.prevalidatedConfig).toBeUndefined();
    });
  });

  describe('3. ArbitrageScanner Hyperspeed Integration', () => {
    it('exposes getSurvivalStats and LatencyReport correctly', () => {
      const tracker = new LatencyTracker();
      tracker.recordSignalQualification(true, true, 1.25);
      tracker.recordSignalQualification(true, false, 0, 'SLOT_ADVANCED');

      const rep = tracker.getReport();
      expect(rep.survivalStats.qualifiedSignalsCount).toBe(2);
      expect(rep.survivalStats.revalidatedSignalsCount).toBe(1);
      expect(rep.survivalStats.revalidationSurvivalPercentage).toBe(50.0);
      expect(rep.survivalStats.accumulatedConservativeNetUSDC).toBe(1.25);
      expect(rep.survivalStats.disappearanceReasons['SLOT_ADVANCED']).toBe(1);
    });
  });
});
