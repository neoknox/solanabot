import { describe, it, expect } from 'vitest';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { PoolConfig } from '../src/scanner/poolRegistry.js';
import { LatencyTracker } from '../src/telemetry/latencyTracker.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';

describe('Phase 1.1 Acceptance: Route Indexing & Latency Instrumentation', () => {
  const mockPools: PoolConfig[] = [
    {
      id: 'pool-raydium-amm',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 25,
      initialLiquidityUsd: 15000000
    },
    {
      id: 'pool-orca-whirlpool',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 4,
      initialLiquidityUsd: 32000000
    },
    {
      id: 'pool-meteora-dlmm',
      dex: 'METEORA_DLMM',
      programId: KNOWN_PROGRAM_IDS.METEORA_DLMM,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 10,
      initialLiquidityUsd: 500000
    }
  ];

  it('Matrix R.1: RouteIndex builds dependency graph and retrieves affected routes in O(1)', () => {
    const index = new RouteIndex(mockPools);

    // 3 pools -> 3 * 2 = 6 directed routes
    expect(index.getRouteCount()).toBe(6);

    // When pool-raydium-amm updates, affected routes must include only routes referencing it
    const affected = index.getRoutesAffectedByPool('pool-raydium-amm');
    expect(affected.length).toBe(4); // 2 where it is Leg 1, 2 where it is Leg 2

    for (const r of affected) {
      expect(r.poolAId === 'pool-raydium-amm' || r.poolBId === 'pool-raydium-amm').toBe(true);
    }
  });

  it('Matrix R.2: RouteIndex indexes token-to-pool queries correctly', () => {
    const index = new RouteIndex(mockPools);

    const wsolPools = index.getPoolsByToken(CANONICAL_WSOL_MINT);
    expect(wsolPools.length).toBe(3);

    const usdcPools = index.getPoolsByToken(CANONICAL_USDC_MINT);
    expect(usdcPools.length).toBe(3);

    const unknownTokenPools = index.getPoolsByToken('TokenUnknown1111111111111111111111111111111');
    expect(unknownTokenPools.length).toBe(0);
  });

  it('Matrix R.3: LatencyTracker computes accurate percentiles (p50, p95, p99, max)', () => {
    const tracker = new LatencyTracker();

    // Insert 100 samples from 1 to 100 microseconds
    for (let i = 1; i <= 100; i++) {
      tracker.recordDecisionDuration(i);
      tracker.recordDecodeDuration(i * 0.1);
      tracker.recordQuoteDuration(i * 0.2);
      tracker.recordValidationDuration(i * 0.3);
    }

    const report = tracker.getReport();

    expect(report.detectionToDecisionUs.count).toBe(100);
    expect(report.detectionToDecisionUs.min).toBe(1);
    expect(report.detectionToDecisionUs.p50).toBe(51);
    expect(report.detectionToDecisionUs.p95).toBe(96);
    expect(report.detectionToDecisionUs.p99).toBe(100);
    expect(report.detectionToDecisionUs.max).toBe(100);
  });

  it('Matrix R.4: LatencyTracker tracks slot lag, RPC latency, and reconnection time', () => {
    const tracker = new LatencyTracker();

    tracker.recordSlotLag(3);
    tracker.recordReconnectDuration(420);
    tracker.recordRpcLatency(85);

    const report = tracker.getReport();
    expect(report.lastSlotLag).toBe(3);
    expect(report.lastReconnectDurationMs).toBe(420);
    expect(report.rpcLatencyMs.mean).toBe(85);
  });
});
