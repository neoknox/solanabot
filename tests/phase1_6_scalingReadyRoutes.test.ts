import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, Keypair, AccountInfo } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { RouteIndex, IndexedDirectedRoute } from '../src/scanner/routeIndex.js';
import { PoolRegistry, PoolConfig } from '../src/scanner/poolRegistry.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { CoverageAssessmentService } from '../src/scanner/coverageAssessment.js';
import { loadConfig } from '../src/config/index.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, CANONICAL_USDT_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';

describe('Phase 1.6: Scaling Toward 1,000 READY Routes Suite', () => {
  let config = loadConfig({
    MAX_QUOTE_AGE_MS: '2500',
    MAX_SLOT_GAP: '10',
    MIN_PROFIT_THRESHOLD_USDC: '0.05'
  });

  describe('1. Solana RPC 100-Account Batch Chunking', () => {
    it('automatically chunks getMultipleAccountsAndContext when pubkeys length exceeds 100', async () => {
      const rpc = new SolanaRpcProvider(config);
      const fakeConnection = (rpc as any).connection;

      let callCount = 0;
      const chunksCalled: number[] = [];

      fakeConnection.getMultipleAccountsInfoAndContext = vi.fn().mockImplementation(async (keys: PublicKey[]) => {
        callCount++;
        chunksCalled.push(keys.length);
        return {
          context: { slot: 1000 + callCount },
          value: keys.map(() => ({
            data: Buffer.alloc(100),
            executable: false,
            lamports: 1000000,
            owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL)
          }))
        };
      });

      // Generate 250 pubkeys (requires 3 chunks: 100, 100, 50)
      const pubkeys = Array.from({ length: 250 }, () => Keypair.generate().publicKey);

      const result = await rpc.getMultipleAccountsAndContext(pubkeys);

      expect(callCount).toBe(3);
      expect(chunksCalled).toEqual([100, 100, 50]);
      expect(result.value.length).toBe(250);
      expect(result.slot).toBe(1003); // latest slot tracked
    });

    it('returns empty result cleanly without RPC call for empty pubkey array', async () => {
      const rpc = new SolanaRpcProvider(config);
      const res = await rpc.getMultipleAccountsAndContext([]);
      expect(res.slot).toBe(0);
      expect(res.value).toEqual([]);
    });
  });

  describe('2. Bottleneck Categorization across Unique Routes', () => {
    it('categorizes non-READY routes into explicit failure categories and counts unique affected routes', () => {
      const pool1: PoolConfig = {
        id: 'pool_orca_1',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'Whirlpool 1',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };

      const pool2: PoolConfig = {
        id: 'pool_clmm_1',
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'Raydium CLMM 1',
        verificationStatus: 'QUOTE_UNVERIFIED',
        blockerReason: 'UNSUPPORTED_PRICING_ADAPTER_CLMM',
        lastVerifiedAt: 0
      };

      const pool3: PoolConfig = {
        id: 'pool_orca_broken',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 2,
        initialLiquidityUsd: 500000,
        description: 'Whirlpool Broken',
        verificationStatus: 'QUOTE_UNVERIFIED',
        blockerReason: 'MISSING_TICK_DATA',
        lastVerifiedAt: 0
      };

      const routeIndex = new RouteIndex([pool1, pool2, pool3]);

      const poolStates = new Map<string, any>([
        [pool1.id, { dex: 'ORCA_WHIRLPOOL', extraData: { tickArrays: { 0: {} } } }],
        [pool2.id, { dex: 'RAYDIUM_CLMM' }],
        [pool3.id, { dex: 'ORCA_WHIRLPOOL', extraData: {} }]
      ]);

      const breakdown = routeIndex.getBottleneckBreakdown((id) => poolStates.get(id), 1000, true);

      expect(breakdown.unsupportedAdapter).toBeGreaterThan(0);
      expect(breakdown.missingTickArrays).toBeGreaterThan(0);
      expect(breakdown.unverifiedPool).toBe(0);
    });

    it('classifies STALE routes with EXPIRED_QUOTE and SLOT_MISMATCH correctly', () => {
      const poolA: PoolConfig = {
        id: 'pool_a',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'A',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };
      const poolB: PoolConfig = {
        id: 'pool_b',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 1000000,
        description: 'B',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };

      const routeIndex = new RouteIndex([poolA, poolB]);
      const routes = routeIndex.getAllRoutes();
      expect(routes.length).toBeGreaterThan(0);

      // Transition route to STALE with EXPIRED_QUOTE
      const route = routes[0];
      routeIndex.setRouteStale(route.routeId, 'EXPIRED_QUOTE:3000ms > 2500ms');

      const poolStates = new Map<string, any>([
        [poolA.id, { dex: 'ORCA_WHIRLPOOL', extraData: { tickArrays: { 0: {} } } }],
        [poolB.id, { dex: 'ORCA_WHIRLPOOL', extraData: { tickArrays: { 0: {} } } }]
      ]);

      const breakdown = routeIndex.getBottleneckBreakdown((id) => poolStates.get(id), 1000, true);
      expect(breakdown.expiredQuote).toBe(1);
    });
  });

  describe('3. Readiness Metrics & Distribution Telemetry', () => {
    it('computes time-weighted average, p10, min, and peak READY counts accurately across samples', () => {
      const poolA: PoolConfig = {
        id: 'pA',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'A',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };
      const poolB: PoolConfig = {
        id: 'pB',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 1000000,
        description: 'B',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };

      const routeIndex = new RouteIndex([poolA, poolB]);
      const routes = routeIndex.getAllRoutes();

      // Sample 1: 0 ready
      routeIndex.recordReadySample();

      // Make 1 route ready
      routeIndex.setRouteReady(routes[0].routeId, { expectedNetUSDC: '0.10', timestamp: Date.now() });

      // Sample 2: 1 ready
      routeIndex.recordReadySample();

      // Make 2 routes ready
      if (routes.length > 1) {
        routeIndex.setRouteReady(routes[1].routeId, { expectedNetUSDC: '0.15', timestamp: Date.now() });
      }

      // Sample 3: 2 ready
      routeIndex.recordReadySample();

      const summary = routeIndex.getReadyMetricsSummary();
      expect(summary.totalSamples).toBe(3);
      expect(summary.minReady).toBe(0);
      expect(summary.peakReady).toBeGreaterThanOrEqual(1);
      expect(summary.timeWeightedReadyAvg).toBeGreaterThan(0);
    });

    it('computes quote age and slot lag distributions across standard histogram buckets', () => {
      const poolA: PoolConfig = {
        id: 'pA',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'A',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };
      const poolB: PoolConfig = {
        id: 'pB',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 1000000,
        description: 'B',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };

      const routeIndex = new RouteIndex([poolA, poolB]);
      const routes = routeIndex.getAllRoutes();

      const now = Date.now();
      routes[0].lastQuoteTimestamp = now - 200; // < 500ms
      if (routes[1]) routes[1].lastQuoteTimestamp = now - 800; // 500-1000ms

      const ageDist = routeIndex.getQuoteAgeDistribution(now);
      expect(ageDist.under500ms).toBe(1);
      if (routes[1]) expect(ageDist.from500to1000ms).toBe(1);

      const poolStates = new Map<string, any>([
        [poolA.id, { slot: 1000 }],
        [poolB.id, { slot: 998 }]
      ]);

      const slotDist = routeIndex.getSlotLagDistribution((id) => poolStates.get(id), 1001);
      expect(slotDist.lag2to4).toBeGreaterThan(0);
    });

    it('accurately tracks per-route uptime and average uptime percent', async () => {
      const poolA: PoolConfig = {
        id: 'pA',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'A',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };
      const poolB: PoolConfig = {
        id: 'pB',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 1000000,
        description: 'B',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };

      const routeIndex = new RouteIndex([poolA, poolB]);
      const routes = routeIndex.getAllRoutes();

      routeIndex.setRouteReady(routes[0].routeId);
      await new Promise(r => setTimeout(r, 50));
      routeIndex.setRouteStale(routes[0].routeId, 'EXPIRED_QUOTE');

      const uptimeReport = routeIndex.getRouteUptimeReport(100);
      expect(uptimeReport.routeUptimes.length).toBeGreaterThan(0);
      const r0Stats = uptimeReport.routeUptimes.find(u => u.routeId === routes[0].routeId);
      expect(r0Stats).toBeDefined();
      expect(r0Stats!.readyDurationMs).toBeGreaterThan(30);
    });
  });

  describe('4. Fast-Path BLOCKED Skip & Scaling Optimizations', () => {
    it('getRoutesAffectedByPool skips BLOCKED routes when onlyEligible is true', () => {
      const poolDirect: PoolConfig = {
        id: 'p_direct',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'Direct',
        verificationStatus: 'VERIFIED_DIRECT',
        lastVerifiedAt: Date.now()
      };

      const poolBlocked: PoolConfig = {
        id: 'p_blocked',
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 4,
        initialLiquidityUsd: 1000000,
        description: 'Blocked',
        verificationStatus: 'QUOTE_UNVERIFIED',
        blockerReason: 'UNSUPPORTED_PRICING_ADAPTER_CLMM',
        lastVerifiedAt: 0
      };

      const routeIndex = new RouteIndex([poolDirect, poolBlocked]);

      const allAffected = routeIndex.getRoutesAffectedByPool(poolDirect.id, false);
      const activeAffected = routeIndex.getRoutesAffectedByPool(poolDirect.id, true);

      expect(allAffected.length).toBeGreaterThan(0);
      expect(activeAffected.length).toBe(0); // All routes involving p_blocked are in BLOCKED state
    });
  });

  describe('5. Quantitative Coverage Assessment', () => {
    it('computes coverage metrics, per-pool route utilization, and projected adapter gains', () => {
      const poolReg = new PoolRegistry();
      const allPools = poolReg.getAllPools();
      const routeIndex = new RouteIndex(allPools);

      const report = CoverageAssessmentService.assessCoverage(poolReg, routeIndex);

      expect(report.totalUniversePools).toBe(allPools.length);
      expect(report.totalConfiguredRoutes).toBe(routeIndex.getRouteCount());
      expect(report.adapterAssessments.length).toBe(2);

      const clmmAssessment = report.adapterAssessments.find(a => a.dexType === 'RAYDIUM_CLMM');
      expect(clmmAssessment).toBeDefined();
      expect(clmmAssessment!.candidatePoolsCount).toBeGreaterThanOrEqual(1);
    });
  });
});
