import { PublicKey } from '@solana/web3.js';
import {
  tickIndexToSqrtPrice,
  tryGetAmountDeltaA,
  tryGetAmountDeltaB,
  tryGetNextSqrtPriceFromA,
  tryGetNextSqrtPriceFromB
} from '@orca-so/whirlpools-core';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote, RejectionReasonCode } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, ALLOWLISTED_MINTS } from '../config/index.js';
import {
  RaydiumClmmTickArray,
  RaydiumClmmTickState,
  RAYDIUM_CLMM_TICK_ARRAY_SIZE,
  getRaydiumClmmArrayStartIndex
} from './raydiumClmmTickArray.js';
import { RaydiumClmmAmmConfig } from './raydiumClmmAmmConfig.js';

const FEE_RATE_DENOMINATOR = 1_000_000n; // Raydium CLMM fee rate in parts per million (10^-6)
const Q128 = 1n << 128n;

export class RaydiumClmmAdapter implements DexAdapter {
  public readonly dex: DexType = 'RAYDIUM_CLMM';
  public readonly programId: string = KNOWN_PROGRAM_IDS.RAYDIUM_CLMM;

  private lastFailureReason: RejectionReasonCode | null = null;

  public getLastFailureReason(): RejectionReasonCode | null {
    return this.lastFailureReason;
  }

  public decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null {
    if (data.length < 1544) return null;

    try {
      const ammConfig = new PublicKey(data.subarray(9, 41)).toBase58();
      const tokenMint0 = new PublicKey(data.subarray(73, 105)).toBase58();
      const tokenMint1 = new PublicKey(data.subarray(105, 137)).toBase58();
      const tokenVault0 = new PublicKey(data.subarray(137, 169)).toBase58();
      const tokenVault1 = new PublicKey(data.subarray(169, 201)).toBase58();
      const observationKey = new PublicKey(data.subarray(201, 233)).toBase58();
      const mintDecimals0 = data.readUInt8(233);
      const mintDecimals1 = data.readUInt8(234);
      const tickSpacing = data.readUInt16LE(235);

      const lowLiq = data.readBigUInt64LE(237);
      const highLiq = data.readBigUInt64LE(245);
      const liquidity = (highLiq << 64n) | lowLiq;

      const lowSqrt = data.readBigUInt64LE(253);
      const highSqrt = data.readBigUInt64LE(261);
      const sqrtPriceX64 = (highSqrt << 64n) | lowSqrt;

      const tickCurrent = data.readInt32LE(269);

      if (!ALLOWLISTED_MINTS.has(tokenMint0) || !ALLOWLISTED_MINTS.has(tokenMint1) || tokenMint0 === tokenMint1) {
        return null;
      }

      if (liquidity <= 0n || sqrtPriceX64 <= 0n) {
        return null;
      }

      return {
        id: poolId,
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: tokenMint0,
        tokenBMint: tokenMint1,
        tokenADecimals: mintDecimals0,
        tokenBDecimals: mintDecimals1,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 0, // Dynamic: updated from verified on-chain AmmConfig
        slot,
        receivedAt: Date.now(),
        liquidityUsd: 0,
        feedHealth: 'HEALTHY',
        extraData: {
          ammConfig,
          tokenVaultA: tokenVault0,
          tokenVaultB: tokenVault1,
          observationKey,
          mintDecimalsA: mintDecimals0,
          mintDecimalsB: mintDecimals1,
          tickSpacing,
          liquidity: liquidity.toString(),
          sqrtPrice: sqrtPriceX64.toString(),
          tickCurrent
          // tradeFeeRate populated when on-chain AmmConfig is resolved
        }
      };
    } catch {
      return null;
    }
  }

  public quoteExactInput(pool: PoolState, inputMint: string, amountIn: bigint): SwapQuote | null {
    this.lastFailureReason = null;

    if (amountIn <= 0n) {
      this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
      return null;
    }

    if (inputMint !== pool.tokenAMint && inputMint !== pool.tokenBMint) {
      this.lastFailureReason = 'INVALID_MINT';
      return null;
    }

    const now = Date.now();

    // Strict Freshness: Require valid timestamp and slot metadata on pool
    if (!pool.receivedAt || now - pool.receivedAt > 2500 || pool.receivedAt > now + 5000) {
      this.lastFailureReason = 'STALE_QUOTE';
      return null;
    }
    if (!pool.slot || pool.slot <= 0) {
      this.lastFailureReason = 'QUOTE_UNVERIFIED';
      return null;
    }
    if (pool.feedHealth && pool.feedHealth !== 'HEALTHY') {
      this.lastFailureReason = 'STALE_QUOTE';
      return null;
    }

    const extra = pool.extraData as {
      liquidity?: string;
      sqrtPrice?: string;
      tickCurrent?: number;
      tickSpacing?: number;
      tradeFeeRate?: number;
      ammConfigData?: RaydiumClmmAmmConfig;
      feeRate?: number;
      maxPriceImpactBps?: number;
      tickArrays?: Record<number, RaydiumClmmTickArray>;
      tickArrayReceivedAt?: Record<number, number>;
      tickArraySlots?: Record<number, number>;
    } | undefined;

    // Resolve dynamic pool fee from verified on-chain AmmConfig (fails closed if missing or invalid)
    const tradeFeeRate =
      extra?.tradeFeeRate ??
      extra?.ammConfigData?.tradeFeeRate ??
      (extra?.feeRate !== undefined ? extra.feeRate : (pool.feeBps ? pool.feeBps * 100 : undefined));

    if (tradeFeeRate === undefined || tradeFeeRate < 0 || tradeFeeRate > 1_000_000) {
      this.lastFailureReason = 'QUOTE_UNVERIFIED';
      return null;
    }

    const liquidity = BigInt(extra?.liquidity || '0');
    const sqrtPrice = BigInt(extra?.sqrtPrice || '0');
    const tickCurrent = extra?.tickCurrent;
    const tickSpacing = extra?.tickSpacing || 1;

    if (tickCurrent === undefined || !extra?.sqrtPrice) {
      this.lastFailureReason = 'MISSING_TICK_DATA';
      return null;
    }
    if (liquidity <= 0n) {
      this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
      return null;
    }
    if (sqrtPrice <= 0n) {
      this.lastFailureReason = 'QUOTE_UNVERIFIED';
      return null;
    }

    const isInputA = inputMint === pool.tokenAMint;
    const zeroForOne = isInputA;
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    const loadedTickArrays = extra?.tickArrays;
    if (!loadedTickArrays) {
      this.lastFailureReason = 'MISSING_TICK_DATA';
      return null;
    }

    const getTickArray = (idx: number): RaydiumClmmTickArray | undefined => {
      if (loadedTickArrays instanceof Map) return (loadedTickArrays as Map<number, RaydiumClmmTickArray>).get(idx);
      return loadedTickArrays[idx];
    };

    // Hydration check: Only the tick array containing tickCurrent is strictly required up front
    const currentStart = getRaydiumClmmArrayStartIndex(tickCurrent, tickSpacing);
    const initialArray = getTickArray(currentStart);
    if (!initialArray) {
      this.lastFailureReason = 'MISSING_TICK_DATA';
      return null;
    }

    const arrayTimestamps = extra?.tickArrayReceivedAt;
    const arraySlots = extra?.tickArraySlots;

    // Strict Freshness: Validate current tick array timestamp and slot consistency
    const initT = arrayTimestamps?.[currentStart];
    const initS = arraySlots?.[currentStart];
    if (!initT || !initS) {
      this.lastFailureReason = 'MISSING_TICK_DATA';
      return null;
    }
    if (now - initT > 2500 || initT > now + 5000) {
      this.lastFailureReason = 'STALE_QUOTE';
      return null;
    }
    if (Math.abs(pool.slot - initS) > 10) {
      this.lastFailureReason = 'SLOT_MISMATCH';
      return null;
    }

    // Directional Multi-Tick Concentrated Liquidity Traversal
    // Matches Raydium CLMM official integer rounding and per-step fee calculations
    const feeRateBig = BigInt(tradeFeeRate);
    const arraySpan = RAYDIUM_CLMM_TICK_ARRAY_SIZE * tickSpacing;

    let currentArray: RaydiumClmmTickArray = initialArray;
    let currentArrayStart: number = currentStart;
    let amountRemaining = amountIn;
    let totalAmountOut = 0n;
    let totalFee = 0n;
    let currentSqrtPrice = sqrtPrice;
    let currentLiquidity = liquidity;
    let currTick = tickCurrent;

    while (amountRemaining > 0n) {
      // Find all initialized ticks in currentArray along the swap direction
      const ticksInArray = currentArray.ticks.filter(t => t.initialized);
      const relevantTicks = zeroForOne
        ? ticksInArray.filter(t => t.tick <= currTick).sort((a, b) => b.tick - a.tick)
        : ticksInArray.filter(t => t.tick > currTick).sort((a, b) => a.tick - b.tick);

      let stepCompletedInArray = false;

      for (const targetTickState of relevantTicks) {
        if (amountRemaining <= 0n) break;

        const targetTick = targetTickState.tick;
        const targetSqrtPrice = tickIndexToSqrtPrice(targetTick);

        // Raydium step fee calculation: amount_for_price_calc = floor(amount_remaining * (DENOM - fee_rate) / DENOM)
        const amountForPriceCalc = (amountRemaining * (FEE_RATE_DENOMINATOR - feeRateBig)) / FEE_RATE_DENOMINATOR;

        let maxAmountIn: bigint;
        if (zeroForOne) {
          maxAmountIn = tryGetAmountDeltaA(targetSqrtPrice, currentSqrtPrice, currentLiquidity, true);
        } else {
          maxAmountIn = tryGetAmountDeltaB(currentSqrtPrice, targetSqrtPrice, currentLiquidity, true);
        }

        if (maxAmountIn === 0n) {
          // Already at tick price: cross tick directly
          if (zeroForOne) {
            currentLiquidity -= targetTickState.liquidityNet;
            currTick = targetTick - 1;
          } else {
            currentLiquidity += targetTickState.liquidityNet;
            currTick = targetTick;
          }
          currentSqrtPrice = targetSqrtPrice;
          continue;
        }

        if (amountForPriceCalc >= maxAmountIn) {
          // Step reaches initialized tick boundary
          let stepAmountOut: bigint;
          if (zeroForOne) {
            stepAmountOut = tryGetAmountDeltaB(targetSqrtPrice, currentSqrtPrice, currentLiquidity, false);
          } else {
            stepAmountOut = tryGetAmountDeltaA(currentSqrtPrice, targetSqrtPrice, currentLiquidity, false);
          }

          // fee_amount = ceil(amount_in * fee_rate / (DENOM - fee_rate))
          const stepFee =
            (maxAmountIn * feeRateBig + (FEE_RATE_DENOMINATOR - feeRateBig - 1n)) /
            (FEE_RATE_DENOMINATOR - feeRateBig);
          const consumed = maxAmountIn + stepFee;

          totalAmountOut += stepAmountOut;
          totalFee += stepFee;
          amountRemaining = amountRemaining >= consumed ? amountRemaining - consumed : 0n;
          currentSqrtPrice = targetSqrtPrice;

          // Cross tick: update active liquidity
          if (zeroForOne) {
            currentLiquidity -= targetTickState.liquidityNet;
            currTick = targetTick - 1;
          } else {
            currentLiquidity += targetTickState.liquidityNet;
            currTick = targetTick;
          }

          if (currentLiquidity <= 0n && amountRemaining > 0n) {
            this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
            return null;
          }
        } else {
          // Swap finishes inside this tick range
          let nextSqrtPrice: bigint;
          let stepAmountIn: bigint;
          let stepAmountOut: bigint;

          if (zeroForOne) {
            nextSqrtPrice = tryGetNextSqrtPriceFromA(currentSqrtPrice, currentLiquidity, amountForPriceCalc, true);
            stepAmountIn = tryGetAmountDeltaA(nextSqrtPrice, currentSqrtPrice, currentLiquidity, true);
            stepAmountOut = tryGetAmountDeltaB(nextSqrtPrice, currentSqrtPrice, currentLiquidity, false);
          } else {
            nextSqrtPrice = tryGetNextSqrtPriceFromB(currentSqrtPrice, currentLiquidity, amountForPriceCalc, true);
            stepAmountIn = tryGetAmountDeltaB(currentSqrtPrice, nextSqrtPrice, currentLiquidity, true);
            stepAmountOut = tryGetAmountDeltaA(currentSqrtPrice, nextSqrtPrice, currentLiquidity, false);
          }

          const stepFee = amountRemaining > amountForPriceCalc ? amountRemaining - amountForPriceCalc : 0n;
          totalAmountOut += stepAmountOut;
          totalFee += stepFee;
          currentSqrtPrice = nextSqrtPrice;
          amountRemaining = 0n;
          stepCompletedInArray = true;
          break;
        }
      }

      if (amountRemaining <= 0n || stepCompletedInArray) {
        break;
      }

      // No further initialized ticks in currentArray: step towards currentArray boundary
      const boundaryTick = zeroForOne
        ? currentArrayStart
        : currentArrayStart + arraySpan;
      const boundarySqrtPrice = tickIndexToSqrtPrice(boundaryTick);

      const amountForPriceCalc = (amountRemaining * (FEE_RATE_DENOMINATOR - feeRateBig)) / FEE_RATE_DENOMINATOR;

      let maxAmountInToBoundary: bigint;
      if (zeroForOne) {
        maxAmountInToBoundary = tryGetAmountDeltaA(boundarySqrtPrice, currentSqrtPrice, currentLiquidity, true);
      } else {
        maxAmountInToBoundary = tryGetAmountDeltaB(currentSqrtPrice, boundarySqrtPrice, currentLiquidity, true);
      }

      if (maxAmountInToBoundary === 0n) {
        // Price already at boundary; cross directly into next array
        const nextArrayStart = zeroForOne
          ? currentArrayStart - arraySpan
          : currentArrayStart + arraySpan;
        const nextArray = getTickArray(nextArrayStart);
        if (!nextArray) {
          this.lastFailureReason = 'MISSING_TICK_DATA';
          return null;
        }
        const nextT = arrayTimestamps?.[nextArrayStart];
        const nextS = arraySlots?.[nextArrayStart];
        if (!nextT || !nextS) {
          this.lastFailureReason = 'MISSING_TICK_DATA';
          return null;
        }
        if (now - nextT > 2500 || nextT > now + 5000) {
          this.lastFailureReason = 'STALE_QUOTE';
          return null;
        }
        if (Math.abs(pool.slot - nextS) > 10) {
          this.lastFailureReason = 'SLOT_MISMATCH';
          return null;
        }
        currentArray = nextArray;
        currentArrayStart = nextArrayStart;
        currTick = zeroForOne ? boundaryTick - 1 : boundaryTick;
        continue;
      }

      if (amountForPriceCalc >= maxAmountInToBoundary) {
        // Swap reaches array boundary: requires next tick array to continue
        const nextArrayStart = zeroForOne
          ? currentArrayStart - arraySpan
          : currentArrayStart + arraySpan;

        const nextArray = getTickArray(nextArrayStart);
        if (!nextArray) {
          // Swap exceeded loaded tick arrays: fail closed
          this.lastFailureReason = 'MISSING_TICK_DATA';
          return null;
        }

        const nextT = arrayTimestamps?.[nextArrayStart];
        const nextS = arraySlots?.[nextArrayStart];
        if (!nextT || !nextS) {
          this.lastFailureReason = 'MISSING_TICK_DATA';
          return null;
        }
        if (now - nextT > 2500 || nextT > now + 5000) {
          this.lastFailureReason = 'STALE_QUOTE';
          return null;
        }
        if (Math.abs(pool.slot - nextS) > 10) {
          this.lastFailureReason = 'SLOT_MISMATCH';
          return null;
        }

        let stepAmountOut: bigint;
        if (zeroForOne) {
          stepAmountOut = tryGetAmountDeltaB(boundarySqrtPrice, currentSqrtPrice, currentLiquidity, false);
        } else {
          stepAmountOut = tryGetAmountDeltaA(currentSqrtPrice, boundarySqrtPrice, currentLiquidity, false);
        }

        const stepFee =
          (maxAmountInToBoundary * feeRateBig + (FEE_RATE_DENOMINATOR - feeRateBig - 1n)) /
          (FEE_RATE_DENOMINATOR - feeRateBig);
        const consumed = maxAmountInToBoundary + stepFee;

        totalAmountOut += stepAmountOut;
        totalFee += stepFee;
        amountRemaining = amountRemaining >= consumed ? amountRemaining - consumed : 0n;
        currentSqrtPrice = boundarySqrtPrice;

        // Transition into the next tick array
        currentArray = nextArray;
        currentArrayStart = nextArrayStart;
        currTick = zeroForOne ? boundaryTick - 1 : boundaryTick;
      } else {
        // Swap completes before reaching array boundary
        let nextSqrtPrice: bigint;
        let stepAmountIn: bigint;
        let stepAmountOut: bigint;

        if (zeroForOne) {
          nextSqrtPrice = tryGetNextSqrtPriceFromA(currentSqrtPrice, currentLiquidity, amountForPriceCalc, true);
          stepAmountIn = tryGetAmountDeltaA(nextSqrtPrice, currentSqrtPrice, currentLiquidity, true);
          stepAmountOut = tryGetAmountDeltaB(nextSqrtPrice, currentSqrtPrice, currentLiquidity, false);
        } else {
          nextSqrtPrice = tryGetNextSqrtPriceFromB(currentSqrtPrice, currentLiquidity, amountForPriceCalc, true);
          stepAmountIn = tryGetAmountDeltaB(currentSqrtPrice, nextSqrtPrice, currentLiquidity, true);
          stepAmountOut = tryGetAmountDeltaA(currentSqrtPrice, nextSqrtPrice, currentLiquidity, false);
        }

        const stepFee = amountRemaining > amountForPriceCalc ? amountRemaining - amountForPriceCalc : 0n;
        totalAmountOut += stepAmountOut;
        totalFee += stepFee;
        currentSqrtPrice = nextSqrtPrice;
        amountRemaining = 0n;
        break;
      }
    }

    if (totalAmountOut <= 0n) {
      this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
      return null;
    }

    // Realistic Price Impact Calculation
    // Compares post-fee actual output against instantaneous marginal output at starting spot price
    let priceImpactBps = 0;
    if (amountIn > 0n && sqrtPrice > 0n) {
      let idealOut = 0n;
      if (zeroForOne) {
        idealOut = (amountIn * sqrtPrice * sqrtPrice) / Q128;
      } else {
        idealOut = (amountIn * Q128) / (sqrtPrice * sqrtPrice);
      }

      if (idealOut > 0n) {
        const diff = idealOut > totalAmountOut ? idealOut - totalAmountOut : 0n;
        priceImpactBps = Number((diff * 10000n) / idealOut);
      } else {
        this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
        return null;
      }
    } else {
      this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
      return null;
    }

    const maxPriceImpactBps = extra?.maxPriceImpactBps ?? 200;
    if (priceImpactBps > maxPriceImpactBps) {
      this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
      return null;
    }

    // Conservative Output Estimate (99.85% factor)
    const conservativeAmountOut = (totalAmountOut * 9985n) / 10000n;

    return {
      quoteSource: 'DIRECT_POOL',
      poolId: pool.id,
      dex: 'RAYDIUM_CLMM',
      inputMint,
      outputMint,
      inAmount: amountIn,
      outAmount: conservativeAmountOut,
      feeIncluded: true,
      feeAmount: totalFee,
      priceImpactBps,
      slot: pool.slot,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC',
      rawRouteInfo: {
        currentSqrtPrice: currentSqrtPrice.toString(),
        finalSqrtPrice: currentSqrtPrice.toString(),
        rawAmountOut: totalAmountOut.toString(),
        effectiveFeePpm: tradeFeeRate
      }
    };
  }
}
