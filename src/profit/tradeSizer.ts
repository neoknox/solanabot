import Decimal from 'decimal.js';
import { AppConfig } from '../config/index.js';
import {
  SwapQuote,
  TradeSizingMethod,
  CostBreakdown,
  PoolState,
  SizeAlternative
} from '../types/index.js';
import { DexAdapter } from '../dex/types.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

export interface QuoterLeg {
  pool: PoolState;
  adapter: DexAdapter;
  inputMint: string;
  outputMint: string;
  slippageBps: number;
}

export interface SizeEvaluation {
  sizeUSDC: number;
  inputUnits: bigint;
  finalExpectedUnits: bigint;
  finalConservativeUnits: bigint;
  expectedNetUSDC: Decimal;
  conservativeNetUSDC: Decimal;
  expectedQuotes: SwapQuote[];
  conservativeQuotes: SwapQuote[];
  quotes: SwapQuote[]; // backwards compatible alias to expectedQuotes
  isViable: boolean;
  rejectionReason?: string;
}

export interface TradeSizerResult {
  optimalSizeUSDC: number;
  maxConservativeNetUSDC: Decimal;
  expectedNetUSDC: Decimal;
  sizingMethod: TradeSizingMethod;
  evaluatedSizesCount: number;
  optimalQuotes: SwapQuote[];
  conservativeQuotes: SwapQuote[];
  topAlternatives: SizeAlternative[];
  allEvaluations: SizeEvaluation[];
}

export class TradeSizer {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Evaluates sequential swaps for a given USDC size along a route.
   * Calculates Expected Output and Conservative Output as strictly SEPARATE paths:
   * - Expected Path: Exact chained swaps, swap fees included, ZERO slippage deducted.
   * - Conservative Path: Exact chained swaps, swap fees included, conservative slippage allowance deducted per leg.
   */
  public evaluateSize(
    sizeUSDC: number,
    legs: QuoterLeg[],
    costs: CostBreakdown,
    currentSlot: number
  ): SizeEvaluation {
    const inputUnits = BigInt(Math.floor(sizeUSDC * 1e6));
    const consumedCostsDecimal = new Decimal(costs.consumedCostUSDC || costs.totalCostsUSDC || '0');
    const safetyBufferDecimal = new Decimal(costs.safetyBufferUSDC || '0');
    const initialDecimal = new Decimal(sizeUSDC);

    // 1. EXPECTED OUTPUT PATH (Exact chained quotes without slippage deduction)
    const expectedQuotes: SwapQuote[] = [];
    let currentExpectedUnits = inputUnits;
    let expectedFailedReason: string | undefined;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (currentExpectedUnits <= 0n) {
        expectedFailedReason = 'INSUFFICIENT_LIQUIDITY';
        break;
      }

      const q = leg.adapter.quoteExactInput(leg.pool, leg.inputMint, currentExpectedUnits);
      if (!q || q.outAmount <= 0n) {
        if (leg.pool.dex === 'ORCA_WHIRLPOOL') {
          expectedFailedReason = 'TICK_BOUNDARY_EXCEEDED';
        } else if (leg.pool.dex === 'METEORA_DLMM') {
          expectedFailedReason = 'UNSUPPORTED_ROUTE';
        } else if (leg.pool.dex === 'RAYDIUM_AMM') {
          expectedFailedReason = (leg.pool.extraData as any)?.unverifiedReason || 'QUOTE_UNVERIFIED';
        } else {
          expectedFailedReason = 'QUOTE_UNVERIFIED';
        }
        break;
      }

      expectedQuotes.push(q);
      currentExpectedUnits = q.outAmount;
    }

    // 2. CONSERVATIVE MINIMUM OUTPUT PATH (Exact chained quotes with per-leg slippage deduction)
    const conservativeQuotes: SwapQuote[] = [];
    let currentConservativeUnits = inputUnits;
    let conservativeFailedReason: string | undefined;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (currentConservativeUnits <= 0n) {
        conservativeFailedReason = 'INSUFFICIENT_LIQUIDITY';
        break;
      }

      const q = leg.adapter.quoteExactInput(leg.pool, leg.inputMint, currentConservativeUnits);
      if (!q || q.outAmount <= 0n) {
        if (leg.pool.dex === 'ORCA_WHIRLPOOL') {
          conservativeFailedReason = 'TICK_BOUNDARY_EXCEEDED';
        } else if (leg.pool.dex === 'METEORA_DLMM') {
          conservativeFailedReason = 'UNSUPPORTED_ROUTE';
        } else if (leg.pool.dex === 'RAYDIUM_AMM') {
          conservativeFailedReason = (leg.pool.extraData as any)?.unverifiedReason || 'QUOTE_UNVERIFIED';
        } else {
          conservativeFailedReason = 'QUOTE_UNVERIFIED';
        }
        break;
      }

      conservativeQuotes.push(q);
      const slippage = (q.outAmount * BigInt(leg.slippageBps)) / 10000n;
      currentConservativeUnits = q.outAmount - slippage;
    }

    if (expectedFailedReason || expectedQuotes.length < legs.length) {
      const reason = expectedFailedReason || 'QUOTE_UNVERIFIED';
      return {
        sizeUSDC,
        inputUnits,
        finalExpectedUnits: 0n,
        finalConservativeUnits: 0n,
        expectedNetUSDC: new Decimal(-999),
        conservativeNetUSDC: new Decimal(-999),
        expectedQuotes: [],
        conservativeQuotes: [],
        quotes: [],
        isViable: false,
        rejectionReason: reason
      };
    }

    const finalExpectedUnits = currentExpectedUnits;
    const finalConservativeUnits = currentConservativeUnits;

    const finalExpectedDecimal = new Decimal(finalExpectedUnits.toString()).div(1e6);
    const finalConservativeDecimal = new Decimal(finalConservativeUnits.toString()).div(1e6);

    const expectedNetUSDC = finalExpectedDecimal
      .sub(initialDecimal)
      .sub(consumedCostsDecimal);

    const conservativeNetUSDC = finalConservativeDecimal
      .sub(initialDecimal)
      .sub(consumedCostsDecimal)
      .sub(safetyBufferDecimal);

    return {
      sizeUSDC,
      inputUnits,
      finalExpectedUnits,
      finalConservativeUnits,
      expectedNetUSDC,
      conservativeNetUSDC,
      expectedQuotes,
      conservativeQuotes,
      quotes: conservativeQuotes,
      isViable: true
    };
  }

  /**
   * Optimal Trade Sizing: Coarse-to-Fine Search
   * 1. Evaluates standard coarse grid (e.g. 25, 50, 100, 250, 500, 1000)
   * 2. If promising, searches bounded fine neighborhood
   * 3. Selects the size that maximizes absolute conservative net USDC
   */
  public findOptimalSize(
    legs: QuoterLeg[],
    costs: CostBreakdown,
    currentSlot: number
  ): TradeSizerResult {
    const coarseGrid = this.config.parsedTradeSizesUSDC;
    const evaluations: SizeEvaluation[] = [];

    // 1. Cheap Spread Pre-Filter at Minimal Trade Size ($25 USDC)
    // In constant-product AMMs and CLMMs, price impact increases monotonically with trade size.
    // If at the minimum size ($25), gross expected return is already < 98% of input (>200 bps gross negative spread),
    // larger sizes will suffer strictly worse price impact and cannot overcome fixed fees to reach +$0.50 net profit.
    const minSize = coarseGrid[0] || 25;
    const firstEval = this.evaluateSize(minSize, legs, costs, currentSlot);

    if (!firstEval.isViable) {
      evaluations.push(firstEval);
      return {
        optimalSizeUSDC: minSize,
        maxConservativeNetUSDC: new Decimal(-999),
        expectedNetUSDC: new Decimal(-999),
        sizingMethod: 'COARSE_GRID',
        evaluatedSizesCount: 1,
        optimalQuotes: [],
        conservativeQuotes: [],
        topAlternatives: [],
        allEvaluations: evaluations
      };
    }

    // Check gross output spread pre-filter
    const minViableExpectedUnits = (firstEval.inputUnits * 98n) / 100n;
    if (firstEval.finalExpectedUnits < minViableExpectedUnits) {
      firstEval.isViable = false;
      firstEval.rejectionReason = 'SPREAD_PREFILTER_REJECTED';
      evaluations.push(firstEval);
      return {
        optimalSizeUSDC: minSize,
        maxConservativeNetUSDC: firstEval.conservativeNetUSDC,
        expectedNetUSDC: firstEval.expectedNetUSDC,
        sizingMethod: 'COARSE_GRID',
        evaluatedSizesCount: 1,
        optimalQuotes: [],
        conservativeQuotes: [],
        topAlternatives: [],
        allEvaluations: evaluations
      };
    }

    evaluations.push(firstEval);
    let bestCoarseEval: SizeEvaluation = firstEval;

    // 2. Coarse evaluation of remaining grid sizes
    for (let i = 1; i < coarseGrid.length; i++) {
      const size = coarseGrid[i];
      const evalRes = this.evaluateSize(size, legs, costs, currentSlot);
      evaluations.push(evalRes);

      if (evalRes.isViable) {
        if (evalRes.conservativeNetUSDC.gt(bestCoarseEval.conservativeNetUSDC)) {
          bestCoarseEval = evalRes;
        }
      }
    }

    if (!bestCoarseEval) {
      // All sizes failed
      return {
        optimalSizeUSDC: coarseGrid[0],
        maxConservativeNetUSDC: new Decimal(-999),
        expectedNetUSDC: new Decimal(-999),
        sizingMethod: 'COARSE_GRID',
        evaluatedSizesCount: evaluations.length,
        optimalQuotes: [],
        conservativeQuotes: [],
        topAlternatives: [],
        allEvaluations: evaluations
      };
    }

    // 2. Determine if fine search is warranted
    let bestOverallEval = bestCoarseEval;
    let sizingMethod: TradeSizingMethod = 'COARSE_GRID';

    if (this.config.ENABLE_OPTIMAL_SIZING && bestCoarseEval.conservativeNetUSDC.gt(-0.25)) {
      const bestSize = bestCoarseEval.sizeUSDC;
      const minBound = Math.max(25, Math.floor(bestSize * 0.6));
      const maxBound = Math.min(this.config.VIRTUAL_CAPITAL_USDC, Math.ceil(bestSize * 1.4));

      // Generate probe points in [minBound, maxBound]
      const step = Math.max(5, Math.floor((maxBound - minBound) / 5));
      const probeSizes: number[] = [];
      for (let s = minBound; s <= maxBound; s += step) {
        if (!coarseGrid.includes(s) && !probeSizes.includes(s)) {
          probeSizes.push(s);
        }
      }

      for (const size of probeSizes) {
        const fineEval = this.evaluateSize(size, legs, costs, currentSlot);
        evaluations.push(fineEval);

        if (fineEval.isViable) {
          if (fineEval.conservativeNetUSDC.gt(bestOverallEval.conservativeNetUSDC)) {
            bestOverallEval = fineEval;
            sizingMethod = 'COARSE_TO_FINE';
          }
        }
      }
    }

    const topAlternatives: SizeAlternative[] = evaluations
      .filter(e => e.sizeUSDC !== bestOverallEval.sizeUSDC)
      .sort((a, b) => b.conservativeNetUSDC.comparedTo(a.conservativeNetUSDC))
      .slice(0, 3)
      .map(e => ({
        sizeUSDC: e.sizeUSDC,
        expectedNetUSDC: e.expectedNetUSDC.toFixed(4),
        conservativeNetUSDC: e.conservativeNetUSDC.toFixed(4),
        isViable: e.isViable,
        rejectionReason: e.rejectionReason
      }));

    return {
      optimalSizeUSDC: bestOverallEval.sizeUSDC,
      maxConservativeNetUSDC: bestOverallEval.conservativeNetUSDC,
      expectedNetUSDC: bestOverallEval.expectedNetUSDC,
      sizingMethod,
      evaluatedSizesCount: evaluations.length,
      optimalQuotes: bestOverallEval.expectedQuotes,
      conservativeQuotes: bestOverallEval.conservativeQuotes,
      topAlternatives,
      allEvaluations: evaluations
    };
  }
}
