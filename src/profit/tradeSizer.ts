import Decimal from 'decimal.js';
import { AppConfig } from '../config/index.js';
import {
  SwapQuote,
  TradeSizingMethod,
  CostBreakdown,
  PoolState
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
  quotes: SwapQuote[];
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
  allEvaluations: SizeEvaluation[];
}

export class TradeSizer {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Evaluates sequential swaps for a given USDC size along a route
   */
  public evaluateSize(
    sizeUSDC: number,
    legs: QuoterLeg[],
    costs: CostBreakdown,
    currentSlot: number
  ): SizeEvaluation {
    const inputUnits = BigInt(Math.floor(sizeUSDC * 1e6));
    const quotes: SwapQuote[] = [];
    let currentInputUnits = inputUnits;

    const totalCostsDecimal = new Decimal(costs.totalCostsUSDC);
    const safetyBufferDecimal = new Decimal(costs.safetyBufferUSDC);
    const initialDecimal = new Decimal(sizeUSDC);

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (currentInputUnits <= 0n) {
        return {
          sizeUSDC,
          inputUnits,
          finalExpectedUnits: 0n,
          finalConservativeUnits: 0n,
          expectedNetUSDC: new Decimal(-999),
          conservativeNetUSDC: new Decimal(-999),
          quotes: [],
          isViable: false,
          rejectionReason: 'INSUFFICIENT_LIQUIDITY'
        };
      }

      const quote = leg.adapter.quoteExactInput(leg.pool, leg.inputMint, currentInputUnits);
      if (!quote || quote.outAmount <= 0n) {
        return {
          sizeUSDC,
          inputUnits,
          finalExpectedUnits: 0n,
          finalConservativeUnits: 0n,
          expectedNetUSDC: new Decimal(-999),
          conservativeNetUSDC: new Decimal(-999),
          quotes: [],
          isViable: false,
          rejectionReason: 'QUOTE_UNVERIFIED'
        };
      }

      quotes.push(quote);

      // Deduct conservative slippage allowance for input to next leg
      const slippage = (quote.outAmount * BigInt(leg.slippageBps)) / 10000n;
      currentInputUnits = quote.outAmount - slippage;
    }

    const lastQuote = quotes[quotes.length - 1];
    const finalExpectedUnits = lastQuote.outAmount;
    const lastLegSlippageBps = BigInt(legs[legs.length - 1].slippageBps);
    const lastSlippage = (finalExpectedUnits * lastLegSlippageBps) / 10000n;
    const finalConservativeUnits = finalExpectedUnits - lastSlippage;

    // Output is in USDC (6 decimals)
    const finalExpectedDecimal = new Decimal(finalExpectedUnits.toString()).div(1e6);
    const finalConservativeDecimal = new Decimal(finalConservativeUnits.toString()).div(1e6);

    const expectedNetUSDC = finalExpectedDecimal
      .sub(initialDecimal)
      .sub(totalCostsDecimal);

    const conservativeNetUSDC = finalConservativeDecimal
      .sub(initialDecimal)
      .sub(totalCostsDecimal)
      .sub(safetyBufferDecimal);

    return {
      sizeUSDC,
      inputUnits,
      finalExpectedUnits,
      finalConservativeUnits,
      expectedNetUSDC,
      conservativeNetUSDC,
      quotes,
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

    // 1. Coarse evaluation
    let bestCoarseEval: SizeEvaluation | null = null;

    for (const size of coarseGrid) {
      const evalRes = this.evaluateSize(size, legs, costs, currentSlot);
      evaluations.push(evalRes);

      if (evalRes.isViable) {
        if (!bestCoarseEval || evalRes.conservativeNetUSDC.gt(bestCoarseEval.conservativeNetUSDC)) {
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
        allEvaluations: evaluations
      };
    }

    // 2. Determine if fine search is warranted
    // If best coarse net is near zero or positive (e.g. > -$0.25), run bounded fine search
    let bestOverallEval = bestCoarseEval;
    let sizingMethod: TradeSizingMethod = 'COARSE_GRID';

    if (this.config.ENABLE_OPTIMAL_SIZING && bestCoarseEval.conservativeNetUSDC.gt(-0.25)) {
      sizingMethod = 'COARSE_TO_FINE';
      const bestSize = bestCoarseEval.sizeUSDC;
      const minBound = Math.max(25, Math.floor(bestSize * 0.6));
      const maxBound = Math.min(this.config.VIRTUAL_CAPITAL_USDC, Math.ceil(bestSize * 1.4));

      // Generate 5 probe points in [minBound, maxBound]
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
          }
        }
      }
    }

    return {
      optimalSizeUSDC: bestOverallEval.sizeUSDC,
      maxConservativeNetUSDC: bestOverallEval.conservativeNetUSDC,
      expectedNetUSDC: bestOverallEval.expectedNetUSDC,
      sizingMethod,
      evaluatedSizesCount: evaluations.length,
      optimalQuotes: bestOverallEval.quotes,
      allEvaluations: evaluations
    };
  }
}
