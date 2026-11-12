import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { PoolRegistry, PoolConfig } from '../src/scanner/poolRegistry.js';
import { TradeSizer, QuoterLeg } from '../src/profit/tradeSizer.js';
import { loadConfig, CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT, CANONICAL_USDT_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';
import { CostBreakdown, PoolState, SwapQuote } from '../src/types/index.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';

describe('Phase 1.2 Acceptance: Competitive Route Search & Optimal Sizing', () => {
  const config = loadConfig();
  const poolRegistry = new PoolRegistry();

  const dummyCosts: CostBreakdown = {
    networkFeeUSDC: '0.000625',
    priorityFeeUSDC: '0.001250',
    jitoTipUSDC: '0.000000',
    tokenTransferFeesUSDC: '0.000000',
    contingencyUSDC: '0.0200',
    safetyBufferUSDC: '0.2500',
    totalCostsUSDC: '0.021875',
    solPriceUSDC: '165.00',
    recoverableDepositUSDC: '0.336481',
    consumedCostUSDC: '0.021875',
    potentialLossOnFailureUSDC: '0.001875',
    riskRewardRatio: '0.00',
    assumptions: ['Phase 1.2 standard test costs']
  };

  it('Matrix 1.2-A: RouteIndex builds 2-leg and 3-leg cycles, intra-DEX, and inter-DEX routes', () => {
    const index = new RouteIndex(poolRegistry.getAllPools());
    const allRoutes = index.getAllRoutes();

    expect(allRoutes.length).toBeGreaterThan(10);
    expect(index.getTwoLegRouteCount()).toBeGreaterThan(0);
    expect(index.getThreeLegRouteCount()).toBeGreaterThan(0);
    expect(index.getIntraDexRouteCount()).toBeGreaterThan(0);
    expect(index.getInterDexRouteCount()).toBeGreaterThan(0);

    // Assert safety invariants on all routes
    for (const route of allRoutes) {
      // Must start and end in canonical USDC
      expect(route.inputMint).toBe(CANONICAL_USDC_MINT);
      expect(route.outputMint).toBe(CANONICAL_USDC_MINT);

      // Must not reuse duplicate pools
      expect(route.poolIds.length).toBe(new Set(route.poolIds).size);

      // Must satisfy Solana transaction limits
      expect(route.estimatedAccounts).toBeLessThanOrEqual(64);
      expect(route.estimatedComputeUnits).toBeLessThanOrEqual(1400000);

      // Leg count matches cycle type
      if (route.cycleType === '2_LEG') {
        expect(route.legs.length).toBe(2);
        expect(route.legs[0].inputMint).toBe(CANONICAL_USDC_MINT);
        expect(route.legs[1].outputMint).toBe(CANONICAL_USDC_MINT);
      } else {
        expect(route.legs.length).toBe(3);
        expect(route.legs[0].inputMint).toBe(CANONICAL_USDC_MINT);
        expect(route.legs[1].inputMint).toBe(route.legs[0].outputMint);
        expect(route.legs[2].inputMint).toBe(route.legs[1].outputMint);
        expect(route.legs[2].outputMint).toBe(CANONICAL_USDC_MINT);
      }
    }
  });

  it('Matrix 1.2-B: Sequential Exact Output Flow across 3-Leg Triangular Cycles', () => {
    const sizer = new TradeSizer(config);

    // Mock Pool 1: USDC -> WSOL (Orca Whirlpool)
    const pool1: PoolState = {
      id: 'mock-whirlpool-sol-usdc',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      feeBps: 4,
      slot: 1000,
      receivedAt: Date.now(),
      liquidityUsd: 10000000,
      feedHealth: 'HEALTHY',
      extraData: {
        sqrtPrice: '473663677464000000000', // ~ $165.00
        tickCurrent: -19800,
        tickSpacing: 64,
        liquidity: '50000000000000000'
      }
    };

    // Mock Pool 2: WSOL -> USDT (Raydium AMM V4)
    const pool2: PoolState = {
      id: 'mock-raydium-sol-usdt',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDT_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 10000000000000n, // 10,000 SOL
      reserveB: 1660000000000n,  // 1,660,000 USDT ($166/SOL - slight premium)
      feeBps: 25,
      slot: 1000,
      receivedAt: Date.now(),
      liquidityUsd: 3300000,
      feedHealth: 'HEALTHY'
    };

    // Mock Pool 3: USDT -> USDC (Orca Whirlpool stable pair)
    const pool3: PoolState = {
      id: 'mock-whirlpool-usdc-usdt',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_USDC_MINT,
      tokenBMint: CANONICAL_USDT_MINT,
      tokenADecimals: 6,
      tokenBDecimals: 6,
      feeBps: 1,
      slot: 1000,
      receivedAt: Date.now(),
      liquidityUsd: 25000000,
      feedHealth: 'HEALTHY',
      extraData: {
        sqrtPrice: '18446744073709551616', // 1:1 price
        tickCurrent: 0,
        tickSpacing: 1,
        liquidity: '1000000000000000000'
      }
    };

    const quoterLegs: QuoterLeg[] = [
      { pool: pool1, adapter: new OrcaWhirlpoolAdapter(), inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: pool2, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDT_MINT, slippageBps: 10 },
      { pool: pool3, adapter: new OrcaWhirlpoolAdapter(), inputMint: CANONICAL_USDT_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    const result = sizer.evaluateSize(100, quoterLegs, dummyCosts, 1000);
    expect(result.isViable).toBe(true);
    expect(result.quotes.length).toBe(3);

    // Verify sequential token outputs: Out_leg1 -> In_leg2, Out_leg2 -> In_leg3
    const q1 = result.quotes[0];
    const q2 = result.quotes[1];
    const q3 = result.quotes[2];

    expect(q1.inputMint).toBe(CANONICAL_USDC_MINT);
    expect(q1.outputMint).toBe(CANONICAL_WSOL_MINT);
    expect(q2.inputMint).toBe(CANONICAL_WSOL_MINT);
    expect(q2.outputMint).toBe(CANONICAL_USDT_MINT);
    expect(q3.inputMint).toBe(CANONICAL_USDT_MINT);
    expect(q3.outputMint).toBe(CANONICAL_USDC_MINT);

    // Exact sequential input: leg2 inAmount must match leg1 conservative outAmount
    const conservativeWSOL = q1.outAmount - (q1.outAmount * 10n) / 10000n;
    expect(q2.inAmount).toBe(conservativeWSOL);

    const conservativeUSDT = q2.outAmount - (q2.outAmount * 10n) / 10000n;
    expect(q3.inAmount).toBe(conservativeUSDT);
  });

  it('Matrix 1.2-C: Optimal Trade Sizer selects size that maximizes absolute conservative net profit', () => {
    const sizer = new TradeSizer(config);

    // Create pools with non-linear liquidity consumption
    const poolA: PoolState = {
      id: 'pool-amm-a',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 1000000000000n, // 1,000 SOL
      reserveB: 160000000000n,  // 160,000 USDC ($160/SOL)
      feeBps: 25,
      slot: 1000,
      receivedAt: Date.now(),
      liquidityUsd: 320000,
      feedHealth: 'HEALTHY'
    };

    const poolB: PoolState = {
      id: 'pool-amm-b',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 500000000000n,  // 500 SOL
      reserveB: 83000000000n,   // 83,000 USDC ($166/SOL - noticeable spread)
      feeBps: 25,
      slot: 1000,
      receivedAt: Date.now(),
      liquidityUsd: 166000,
      feedHealth: 'HEALTHY'
    };

    const legs: QuoterLeg[] = [
      { pool: poolA, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: poolB, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    const result = sizer.findOptimalSize(legs, dummyCosts, 1000);

    expect(result.optimalSizeUSDC).toBeGreaterThanOrEqual(25);
    expect(result.optimalSizeUSDC).toBeLessThanOrEqual(1000);
    expect(result.evaluatedSizesCount).toBeGreaterThanOrEqual(6);

    // Verify that optimal size provides higher or equal absolute conservative net than any other evaluated size
    for (const ev of result.allEvaluations) {
      if (ev.isViable) {
        expect(result.maxConservativeNetUSDC.gte(ev.conservativeNetUSDC)).toBe(true);
      }
    }
  });

  it('Matrix 1.2-D: Intra-DEX routes between different fee tiers on Orca Whirlpool', () => {
    const index = new RouteIndex(poolRegistry.getAllPools());
    const routes = index.getAllRoutes();

    // Look for Orca-to-Orca intra-DEX routes (Czfq3xZZ 4bps vs FpCMFDFG 2bps)
    const intraOrca = routes.filter(r => r.dexA === 'ORCA_WHIRLPOOL' && r.dexB === 'ORCA_WHIRLPOOL');
    expect(intraOrca.length).toBeGreaterThan(0);

    for (const r of intraOrca) {
      expect(r.isIntraDex).toBe(true);
      expect(r.poolAId).not.toBe(r.poolBId);
      expect(r.estimatedAccounts).toBeLessThan(40);
    }
  });
});
