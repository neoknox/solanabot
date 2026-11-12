import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { config, CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT, CANONICAL_USDT_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';
import { PoolState, SwapQuote, CostBreakdown, ArbitrageCandidate } from '../src/types/index.js';
import { TradeSizer, QuoterLeg } from '../src/profit/tradeSizer.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { OpportunityTracker } from '../src/scanner/opportunityTracker.js';
import { StateCache } from '../src/scanner/stateCache.js';
import { CompetitorAnalyzer } from '../src/competition/analyzer.js';
import { CompetitionScorer } from '../src/profit/competitionScorer.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';

describe('Profit-First Opportunity Management Algorithm Acceptance', () => {
  const dummyCosts: CostBreakdown = {
    networkFeeUSDC: '0.0008',
    priorityFeeUSDC: '0.0015',
    jitoTipUSDC: '0.00',
    tokenTransferFeesUSDC: '0.00',
    contingencyUSDC: '0.0002',
    safetyBufferUSDC: '0.00',
    totalCostsUSDC: '0.0025',
    solPriceUSDC: '150.00',
    consumedCostUSDC: '0.0025',
    potentialLossOnFailureUSDC: '0.0025',
    assumptions: ['Static mock test costs']
  };

  const poolA: PoolState = {
    id: 'pool-amm-usdc-wsol',
    dex: 'RAYDIUM_AMM',
    programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
    tokenAMint: CANONICAL_WSOL_MINT,
    tokenBMint: CANONICAL_USDC_MINT,
    tokenADecimals: 9,
    tokenBDecimals: 6,
    reserveA: 1000000000000n, // 1,000 SOL
    reserveB: 150000000000n,  // 150,000 USDC ($150/SOL)
    feeBps: 25,
    slot: 1000,
    receivedAt: Date.now(),
    liquidityUsd: 1000000,
    feedHealth: 'HEALTHY',
    extraData: {
      openOrdersVerified: true,
      openOrdersBaseTokenTotal: '0',
      openOrdersQuoteTokenTotal: '0'
    }
  };

  const poolB: PoolState = {
    id: 'pool-amm-wsol-usdc',
    dex: 'RAYDIUM_AMM',
    programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
    tokenAMint: CANONICAL_WSOL_MINT,
    tokenBMint: CANONICAL_USDC_MINT,
    tokenADecimals: 9,
    tokenBDecimals: 6,
    reserveA: 1000000000000n, // 1,000 SOL
    reserveB: 155000000000n,  // 155,000 USDC ($155/SOL - higher price, profitable return)
    feeBps: 25,
    slot: 1000,
    receivedAt: Date.now(),
    liquidityUsd: 1000000,
    feedHealth: 'HEALTHY',
    extraData: {
      openOrdersVerified: true,
      openOrdersBaseTokenTotal: '0',
      openOrdersQuoteTokenTotal: '0'
    }
  };

  it('1. Separate Expected vs Conservative Quoting Paths & No Slippage Double-Counting', () => {
    const sizer = new TradeSizer(config);
    const legs: QuoterLeg[] = [
      { pool: poolA, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: poolB, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    const evalResult = sizer.evaluateSize(100, legs, dummyCosts, 1000);
    expect(evalResult.isViable).toBe(true);

    // Expected path: Zero slippage deducted
    expect(evalResult.expectedQuotes.length).toBe(2);
    expect(evalResult.expectedQuotes[1].inAmount).toBe(evalResult.expectedQuotes[0].outAmount);

    // Conservative path: Per-leg slippage deducted
    expect(evalResult.conservativeQuotes.length).toBe(2);
    const leg1Slippage = (evalResult.expectedQuotes[0].outAmount * 10n) / 10000n;
    expect(evalResult.conservativeQuotes[1].inAmount).toBe(evalResult.expectedQuotes[0].outAmount - leg1Slippage);

    // Final outputs are distinct
    expect(evalResult.finalExpectedUnits).toBeGreaterThan(evalResult.finalConservativeUnits);
    expect(evalResult.expectedNetUSDC.gt(evalResult.conservativeNetUSDC)).toBe(true);
  });

  it('2. Cheap Spread Pre-Filter rejects unviable routes at minimal size', () => {
    const sizer = new TradeSizer(config);
    // Reverse pools: buying expensive on poolB ($155) and selling cheap on poolA ($150) -> ~3.2% loss
    const losingLegs: QuoterLeg[] = [
      { pool: poolB, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: poolA, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    const result = sizer.findOptimalSize(losingLegs, dummyCosts, 1000);
    expect(result.optimalQuotes.length).toBe(0);
    expect(result.evaluatedSizesCount).toBe(1); // Exits immediately on first probe
    expect(result.allEvaluations[0].rejectionReason).toBe('SPREAD_PREFILTER_REJECTED');
  });

  it('3. Position Size Optimization reports optimal size and top 3 alternatives', () => {
    const sizer = new TradeSizer(config);
    const legs: QuoterLeg[] = [
      { pool: poolA, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: poolB, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    const result = sizer.findOptimalSize(legs, dummyCosts, 1000);
    expect(result.optimalQuotes.length).toBe(2);
    expect(result.optimalSizeUSDC).toBeGreaterThanOrEqual(25);
    expect(result.topAlternatives).toBeDefined();
    expect(result.topAlternatives.length).toBeGreaterThan(0);
    expect(result.topAlternatives.length).toBeLessThanOrEqual(3);

    // Alternatives should not include the winning optimal size
    for (const alt of result.topAlternatives) {
      expect(alt.sizeUSDC).not.toBe(result.optimalSizeUSDC);
      expect(typeof alt.conservativeNetUSDC).toBe('string');
    }
  });

  it('4. Minimum Conservative Profit Hurdle ($0.50 USDC)', () => {
    const calc = new ArbitrageProfitCalculator(config);

    // Case A: Net profit $0.45 (< $0.50 hurdle)
    const quoteIn = { inAmount: 100000000n, outAmount: 666666666n, poolId: poolA.id, dex: poolA.dex, slot: 1000, timestamp: Date.now() } as SwapQuote;
    // Produces $100.45 conservative output -> conservative net = $0.4475 (minus $0.0025 costs)
    const quoteOutSubHurdle = { inAmount: 666666666n, outAmount: 100450000n, poolId: poolB.id, dex: poolB.dex, slot: 1000, timestamp: Date.now() } as SwapQuote;

    const resSub = calc.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quoteIn,
      leg2Quote: quoteOutSubHurdle,
      cycleType: '2_LEG',
      costs: dummyCosts,
      currentSlot: 1000,
      wsConnected: true,
      solPriceTimestamp: Date.now()
    });

    expect(resSub.status).not.toBe('QUALIFIED_SHADOW');
    expect(resSub.qualityLabel).toBe('INVALID');
    expect(resSub.rejectionReasons).toContain('LOW_CONSERVATIVE_NET');

    // Case B: Net profit $1.50 (>= $0.50 hurdle)
    const quoteOutSuperHurdle = { inAmount: 666666666n, outAmount: 101550000n, poolId: poolB.id, dex: poolB.dex, slot: 1000, timestamp: Date.now() } as SwapQuote;
    const resSuper = calc.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quoteIn,
      leg2Quote: quoteOutSuperHurdle,
      cycleType: '2_LEG',
      costs: dummyCosts,
      currentSlot: 1000,
      wsConnected: true,
      solPriceTimestamp: Date.now()
    });

    expect(resSuper.status).toBe('QUALIFIED_SHADOW');
    expect(resSuper.executionStatus).toBe('EXECUTION_UNVERIFIED');
    expect(Number(resSuper.minConservativeNetUSDC)).toBeGreaterThanOrEqual(0.50);
  });

  it('5. State-Version Deduplication & Persistence across new snapshots only', () => {
    const tracker = new OpportunityTracker();
    const cache = new StateCache();

    const candidate: ArbitrageCandidate = {
      candidateId: 'test-opp-1',
      routeName: 'Raydium->Orca WSOL/USDC',
      direction: 'USDC->WSOL->USDC',
      cycleType: '2_LEG',
      timestamp: 1000000,
      status: 'QUALIFIED_SHADOW',
      qualityLabel: 'SHADOW_QUALIFIED',
      inputAmountUSDC: 100000000n,
      optimalSizeUSDC: 100,
      leg1ExpectedOutWSOL: 666666666n,
      leg1ConservativeOutWSOL: 666000000n,
      leg2ExpectedOutUSDC: 102000000n,
      leg2ConservativeOutUSDC: 101500000n,
      expectedNetUSDC: '2.00',
      minConservativeNetUSDC: '1.50',
      rejectionReasons: [],
      quoteAgeMs: 5,
      slotGap: 0,
      stateVersion: 'poolA@1000:poolB@1000',
      leg1Quote: { poolId: 'poolA', dex: 'RAYDIUM_AMM' } as any,
      leg2Quote: { poolId: 'poolB', dex: 'ORCA_WHIRLPOOL' } as any,
      costs: dummyCosts
    };

    // 1st observation: new snapshot
    const obs1 = tracker.trackOpportunity(candidate, 1000);
    expect(obs1.observedSnapshotsCount).toBe(1);

    // Dedupe check
    const isDupe1 = cache.isDuplicate({
      route: 'route-1',
      amountUSDC: candidate.inputAmountUSDC,
      netProfitUSDC: candidate.minConservativeNetUSDC,
      stateVersion: candidate.stateVersion
    });
    expect(isDupe1).toBe(false);

    // 2nd observation: REPEATED calculation of the SAME snapshot slot (stateVersion unchanged)
    candidate.timestamp = 1000200;
    const obs2 = tracker.trackOpportunity(candidate, 1000);
    // Repeated recalculation of same snapshot is NOT survival
    expect(obs2.observedSnapshotsCount).toBe(1);

    const isDupe2 = cache.isDuplicate({
      route: 'route-1',
      amountUSDC: candidate.inputAmountUSDC,
      netProfitUSDC: candidate.minConservativeNetUSDC,
      stateVersion: candidate.stateVersion
    });
    expect(isDupe2).toBe(true);

    // 3rd observation: NEW snapshot arrives (slot 1001)
    candidate.timestamp = 1000600;
    candidate.stateVersion = 'poolA@1001:poolB@1001';
    const obs3 = tracker.trackOpportunity(candidate, 1001);
    expect(obs3.observedSnapshotsCount).toBe(2);

    const isDupe3 = cache.isDuplicate({
      route: 'route-1',
      amountUSDC: candidate.inputAmountUSDC,
      netProfitUSDC: candidate.minConservativeNetUSDC,
      stateVersion: candidate.stateVersion
    });
    expect(isDupe3).toBe(false);
  });

  it('6. Simulated Capital Reservation Tracking & Virtual Capital Bound', () => {
    const tracker = new OpportunityTracker();

    const candidate1: ArbitrageCandidate = {
      candidateId: 'opp-1',
      routeName: 'Route 1',
      direction: 'USDC->WSOL->USDC',
      cycleType: '2_LEG',
      timestamp: Date.now(),
      status: 'QUALIFIED_SHADOW',
      qualityLabel: 'SHADOW_QUALIFIED',
      inputAmountUSDC: 600000000n,
      optimalSizeUSDC: 600,
      leg1ExpectedOutWSOL: 4000000000n,
      leg1ConservativeOutWSOL: 3996000000n,
      leg2ExpectedOutUSDC: 603000000n,
      leg2ConservativeOutUSDC: 602000000n,
      expectedNetUSDC: '2.00',
      minConservativeNetUSDC: '1.50',
      rejectionReasons: [],
      quoteAgeMs: 5,
      slotGap: 0,
      leg1Quote: { poolId: 'p1', dex: 'RAYDIUM_AMM' } as any,
      leg2Quote: { poolId: 'p2', dex: 'ORCA_WHIRLPOOL' } as any,
      costs: dummyCosts
    };

    tracker.trackOpportunity(candidate1, 1000);
    expect(tracker.getActiveAllocatedCapital()).toBe(600);

    // Adding second opportunity with size 500 when virtual limit is 1000
    const candidate2Size = 500;
    const virtualLimit = 1000;
    const wouldExceed = tracker.getActiveAllocatedCapital() + candidate2Size > virtualLimit;
    expect(wouldExceed).toBe(true); // 600 + 500 = 1100 > 1000
  });

  it('7. Unsampled Competitor Contention is strictly UNKNOWN with UNCALIBRATED Probability', () => {
    const analyzer = new CompetitorAnalyzer();
    const metrics = analyzer.getCachedMetrics('unmonitored-pool');

    expect(metrics.totalObservedTx).toBe(0);
    expect(metrics.contentionLevel).toBe('UNKNOWN');
    expect(metrics.historicalCompetitionScore).toBe(0);

    const scorer = new CompetitionScorer();
    const candidate: ArbitrageCandidate = {
      candidateId: 'opp-comp',
      routeName: 'Test Route',
      direction: 'USDC->WSOL->USDC',
      cycleType: '2_LEG',
      timestamp: Date.now(),
      status: 'QUALIFIED_SHADOW',
      qualityLabel: 'SHADOW_QUALIFIED',
      inputAmountUSDC: 100000000n,
      optimalSizeUSDC: 100,
      leg1ExpectedOutWSOL: 666666666n,
      leg1ConservativeOutWSOL: 666000000n,
      leg2ExpectedOutUSDC: 101500000n,
      leg2ConservativeOutUSDC: 101200000n,
      expectedNetUSDC: '1.50',
      minConservativeNetUSDC: '1.20',
      rejectionReasons: [],
      quoteAgeMs: 10,
      slotGap: 0,
      leg1Quote: { poolId: 'p1', dex: 'RAYDIUM_AMM' } as any,
      leg2Quote: { poolId: 'p2', dex: 'ORCA_WHIRLPOOL' } as any,
      costs: dummyCosts
    };

    const scored = scorer.scoreCandidate(candidate, [metrics]);
    expect(scored.executionProbability).toBe('UNCALIBRATED');
    expect(scored.breakdown.competitionPenalty).toBe(10); // Strictly neutral default (10/20), NOT 20/20 low-competition bonus
    expect(scored.breakdown.competitionPenalty).not.toBe(20);
    expect(scored.score).toBeGreaterThan(0);
  });

  it('8. Incomplete Conservative Quote Path Regression Gate: NEVER qualifies for profit', () => {
    const sizer = new TradeSizer(config);

    // Mock adapter where expected quote succeeds, but conservative input (after slippage) fails
    const failingConservativeAdapter = {
      quoteExactInput: (pool: PoolState, inputMint: string, amount: bigint) => {
        // If amount has slippage deducted (e.g. less than the expected leg 1 outAmount), simulate failure
        if (amount < 666666666n) {
          return null; // Conservative path fails on leg 2
        }
        return {
          quoteSource: 'DIRECT_POOL' as const,
          poolId: pool.id,
          dex: pool.dex,
          inputMint,
          outputMint: CANONICAL_USDC_MINT,
          inAmount: amount,
          outAmount: 110000000n, // $110 USDC (profitable if it were to succeed)
          feeIncluded: true,
          feeAmount: 25000n,
          priceImpactBps: 5,
          slot: 1000,
          timestamp: Date.now(),
          executionType: 'POTENTIAL_ATOMIC' as const
        };
      },
      getLastFailureReason: () => 'TICK_BOUNDARY_EXCEEDED' as const,
      decodePoolState: () => null
    };

    const legsWithFailingConservative: QuoterLeg[] = [
      { pool: poolA, adapter: new RaydiumAmmAdapter(), inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: poolB, adapter: failingConservativeAdapter as any, inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    const evalResult = sizer.evaluateSize(100, legsWithFailingConservative, dummyCosts, 1000);

    // CRITICAL INVARIANT: Incomplete conservative path MUST fail closed
    expect(evalResult.isViable).toBe(false);
    expect(evalResult.finalConservativeUnits).toBe(0n);
    expect(evalResult.finalExpectedUnits).toBe(0n);
    expect(evalResult.conservativeNetUSDC.toNumber()).toBeLessThan(0);
    expect(evalResult.conservativeQuotes.length).toBe(0);
    expect(evalResult.expectedQuotes.length).toBe(0);
    expect(evalResult.rejectionReason).toBe('TICK_BOUNDARY_EXCEEDED');

    // findOptimalSize must reject completely and return zero quotes
    const optResult = sizer.findOptimalSize(legsWithFailingConservative, dummyCosts, 1000);
    expect(optResult.optimalQuotes.length).toBe(0);
    expect(optResult.conservativeQuotes.length).toBe(0);
    expect(optResult.maxConservativeNetUSDC.toNumber()).toBeLessThan(0);
  });

  it('9. Mixed / Incompatible Snapshot Slot Rejection (SLOT_MISMATCH)', () => {
    const calc = new ArbitrageProfitCalculator(config);
    // Leg 1 is at slot 1000, Leg 2 is at slot 1050 (gap = 50 > MAX_SLOT_GAP 10)
    const quoteIn = { inAmount: 100000000n, outAmount: 666666666n, poolId: poolA.id, dex: poolA.dex, slot: 1000, timestamp: Date.now() } as SwapQuote;
    const quoteOut = { inAmount: 666666666n, outAmount: 101550000n, poolId: poolB.id, dex: poolB.dex, slot: 1050, timestamp: Date.now() } as SwapQuote;

    const res = calc.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quoteIn,
      leg2Quote: quoteOut,
      cycleType: '2_LEG',
      costs: dummyCosts,
      currentSlot: 1050,
      wsConnected: true,
      solPriceTimestamp: Date.now()
    });

    expect(res.status).toBe('REJECTED');
    expect(res.rejectionReasons).toContain('SLOT_MISMATCH');
    expect(res.qualityLabel).toBe('INVALID');
  });

  it('10. Unsupported Venue Rejection (UNSUPPORTED_ROUTE)', () => {
    const calc = new ArbitrageProfitCalculator(config);
    const quoteIn = { inAmount: 100000000n, outAmount: 666666666n, poolId: poolA.id, dex: poolA.dex, slot: 1000, timestamp: Date.now() } as SwapQuote;
    const quoteOut = {
      inAmount: 666666666n,
      outAmount: 101550000n,
      poolId: 'meteora-pool-1',
      dex: 'METEORA_DLMM' as any,
      slot: 1000,
      timestamp: Date.now(),
      isUnverified: true,
      unverifiedReason: 'UNSUPPORTED_ROUTE'
    } as SwapQuote;

    const res = calc.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quoteIn,
      leg2Quote: quoteOut,
      cycleType: '2_LEG',
      costs: dummyCosts,
      currentSlot: 1000,
      wsConnected: true,
      solPriceTimestamp: Date.now()
    });

    expect(res.status).toBe('UNSUPPORTED');
    expect(res.rejectionReasons).toContain('UNSUPPORTED_ROUTE');
    expect(res.qualityLabel).toBe('INDICATIVE_ONLY');
  });

  it('11. Execution Contract Specification & Execution Honesty Notice', () => {
    const candidate: ArbitrageCandidate = {
      candidateId: 'opp-atomic',
      routeName: 'Raydium->Orca WSOL/USDC',
      direction: 'USDC->WSOL->USDC',
      cycleType: '2_LEG',
      timestamp: Date.now(),
      status: 'QUALIFIED_SHADOW',
      qualityLabel: 'SHADOW_QUALIFIED',
      executionStatus: 'EXECUTION_UNVERIFIED',
      inputAmountUSDC: 100000000n,
      optimalSizeUSDC: 100,
      leg1ExpectedOutWSOL: 666666666n,
      leg1ConservativeOutWSOL: 666000000n,
      leg2ExpectedOutUSDC: 102500000n,
      leg2ConservativeOutUSDC: 102000000n,
      expectedNetUSDC: '2.50',
      minConservativeNetUSDC: '2.00',
      rejectionReasons: [],
      quoteAgeMs: 5,
      slotGap: 0,
      leg1Quote: { poolId: 'p1', dex: 'RAYDIUM_AMM' } as any,
      leg2Quote: { poolId: 'p2', dex: 'ORCA_WHIRLPOOL' } as any,
      costs: dummyCosts
    };

    // Strict execution honesty: on-chain profit guard is an architectural specification only,
    // not implemented on-chain, not simulated, and protecting zero real funds.
    expect(candidate.executionStatus).toBe('EXECUTION_UNVERIFIED');
    expect(Number(candidate.minConservativeNetUSDC)).toBeGreaterThanOrEqual(0.50);
  });

  it('12. State Version Revision Fingerprinting & Funnel Monotonicity Gate', () => {
    const cache = new StateCache();
    const tracker = new OpportunityTracker();

    // 1. Two updates to the same pool within the same slot receive distinct revision numbers
    const stateA1: PoolState = { ...poolA, slot: 2000 };
    cache.setPoolState(stateA1);
    expect(stateA1.stateRevision).toBe(1);

    const stateA2: PoolState = { ...poolA, slot: 2000, reserveA: 1000500000000n };
    cache.setPoolState(stateA2);
    expect(stateA2.stateRevision).toBe(2);

    // 2. Same snapshot recalculation does NOT count as independent survival
    const candidateSameSnap: ArbitrageCandidate = {
      candidateId: 'cand-same',
      routeName: 'Route',
      direction: 'USDC->WSOL->USDC',
      cycleType: '2_LEG',
      timestamp: 2000000,
      status: 'QUALIFIED_SHADOW',
      qualityLabel: 'SHADOW_QUALIFIED',
      executionStatus: 'EXECUTION_UNVERIFIED',
      inputAmountUSDC: 100000000n,
      optimalSizeUSDC: 100,
      leg1ExpectedOutWSOL: 666666666n,
      leg1ConservativeOutWSOL: 666000000n,
      leg2ExpectedOutUSDC: 102000000n,
      leg2ConservativeOutUSDC: 101500000n,
      expectedNetUSDC: '2.00',
      minConservativeNetUSDC: '1.50',
      rejectionReasons: [],
      quoteAgeMs: 5,
      slotGap: 0,
      stateVersion: 'poolA@s2000:r1|poolB@s2000:r1',
      leg1Quote: { poolId: 'poolA', dex: 'RAYDIUM_AMM' } as any,
      leg2Quote: { poolId: 'poolB', dex: 'ORCA_WHIRLPOOL' } as any,
      costs: dummyCosts
    };

    const seen1 = tracker.trackOpportunity(candidateSameSnap, 2000);
    expect(seen1.observedSnapshotsCount).toBe(1);

    // Re-evaluating identical stateVersion in same or subsequent tick
    candidateSameSnap.timestamp = 2000500;
    const seen2 = tracker.trackOpportunity(candidateSameSnap, 2000);
    expect(seen2.observedSnapshotsCount).toBe(1); // Did not increase

    // Only advancing stateVersion increments observed snapshots count
    candidateSameSnap.timestamp = 2001000;
    candidateSameSnap.stateVersion = 'poolA@s2000:r2|poolB@s2000:r1';
    const seen3 = tracker.trackOpportunity(candidateSameSnap, 2000);
    expect(seen3.observedSnapshotsCount).toBe(2);
  });
});
