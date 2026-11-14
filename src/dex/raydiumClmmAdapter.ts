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
  getRequiredRaydiumClmmTickArrayStartIndices
} from './raydiumClmmTickArray.js';

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
        feeBps: 25,
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
          tickCurrent,
          feeRate: 2500
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

    // Existing quote freshness checks: 2,500ms max age
    const now = Date.now();
    if (pool.receivedAt && now - pool.receivedAt > 2500) {
      this.lastFailureReason = 'STALE_QUOTE';
      return null;
    }

    const extra = pool.extraData as {
      liquidity?: string;
      sqrtPrice?: string;
      tickCurrent?: number;
      tickSpacing?: number;
      feeRate?: number;
      maxPriceImpactBps?: number;
      tickArrays?: Record<number, RaydiumClmmTickArray>;
      tickArrayReceivedAt?: Record<number, number>;
      tickArraySlots?: Record<number, number>;
    } | undefined;

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
    const direction = zeroForOne ? 'A_TO_B' : 'B_TO_A';

    // Fee rate in ppm (10^-6). E.g., 25 bps = 2500 ppm, 1 bps = 100 ppm
    const feeRate = extra?.feeRate ?? (pool.feeBps ? pool.feeBps * 100 : 2500);
    const feeRateBigInt = BigInt(feeRate);

    // Exact pool fee calculation: fee is deducted from input (ceil)
    const totalFee = (amountIn * feeRateBigInt + (FEE_RATE_DENOMINATOR - 1n)) / FEE_RATE_DENOMINATOR;
    const netAmountIn = amountIn - totalFee;

    if (netAmountIn <= 0n) {
      this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
      return null;
    }

    // Required tick array hydration & validation
    const loadedTickArrays = extra?.tickArrays;
    const requiredStartIndices = getRequiredRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing, direction);

    if (!loadedTickArrays) {
      this.lastFailureReason = 'MISSING_TICK_DATA';
      return null;
    }

    const getTickArray = (idx: number): RaydiumClmmTickArray | undefined => {
      if (loadedTickArrays instanceof Map) return loadedTickArrays.get(idx);
      return loadedTickArrays[idx];
    };

    const hasAllArrays = requiredStartIndices.every(idx => !!getTickArray(idx));
    if (!hasAllArrays) {
      this.lastFailureReason = 'MISSING_TICK_DATA';
      return null;
    }

    // Validate freshness of every required tick array (max age 30,000ms, slot gap <= 100)
    const arrayTimestamps = extra?.tickArrayReceivedAt;
    const arraySlots = extra?.tickArraySlots;
    if (arrayTimestamps && arraySlots) {
      for (const idx of requiredStartIndices) {
        const t = arrayTimestamps[idx];
        const s = arraySlots[idx];
        if (t && (now - t > 30000 || t > now + 5000)) {
          this.lastFailureReason = 'STALE_QUOTE';
          return null;
        }
        if (pool.slot && s && Math.abs(pool.slot - s) > 100) {
          this.lastFailureReason = 'SLOT_MISMATCH';
          return null;
        }
      }
    }

    // Collect all initialized ticks from loaded tick arrays
    const initializedTicks: RaydiumClmmTickState[] = [];
    let minLoadedTick = Infinity;
    let maxLoadedTick = -Infinity;

    for (const startIdx of requiredStartIndices) {
      const arr = getTickArray(startIdx);
      if (!arr) continue;
      const arrayMin = arr.startTickIndex;
      const arrayMax = arr.startTickIndex + RAYDIUM_CLMM_TICK_ARRAY_SIZE * tickSpacing;
      if (arrayMin < minLoadedTick) minLoadedTick = arrayMin;
      if (arrayMax > maxLoadedTick) maxLoadedTick = arrayMax;

      for (const t of arr.ticks) {
        if (t.initialized) {
          initializedTicks.push(t);
        }
      }
    }

    // Sort initialized ticks by traversal order
    if (zeroForOne) {
      // Swapping A -> B (price dropping): traverse initialized ticks <= tickCurrent in descending order
      initializedTicks.sort((a, b) => b.tick - a.tick);
    } else {
      // Swapping B -> A (price rising): traverse initialized ticks > tickCurrent in ascending order
      initializedTicks.sort((a, b) => a.tick - b.tick);
    }

    // Multi-Tick Concentrated Liquidity Traversal
    let netAmountRemaining = netAmountIn;
    let totalAmountOut = 0n;
    let currentSqrtPrice = sqrtPrice;
    let currentLiquidity = liquidity;
    let currentTick = tickCurrent;

    // Filter relevant initialized ticks based on current price/direction
    const relevantTicks = zeroForOne
      ? initializedTicks.filter(t => t.tick <= currentTick)
      : initializedTicks.filter(t => t.tick > currentTick);

    for (let i = 0; i <= relevantTicks.length; i++) {
      if (netAmountRemaining <= 0n) break;

      // Determine step target price
      let targetSqrtPrice: bigint;
      let targetTick: number;
      let isArrayBoundary = false;

      if (i < relevantTicks.length) {
        targetTick = relevantTicks[i].tick;
        targetSqrtPrice = tickIndexToSqrtPrice(targetTick);
      } else {
        // No further initialized ticks; step to loaded array boundary
        isArrayBoundary = true;
        targetTick = zeroForOne ? minLoadedTick : maxLoadedTick;
        targetSqrtPrice = tickIndexToSqrtPrice(targetTick);
      }

      // Max input needed to push price all the way to targetSqrtPrice
      let maxAmountIn: bigint;
      if (zeroForOne) {
        maxAmountIn = tryGetAmountDeltaA(targetSqrtPrice, currentSqrtPrice, currentLiquidity, true);
      } else {
        maxAmountIn = tryGetAmountDeltaB(currentSqrtPrice, targetSqrtPrice, currentLiquidity, true);
      }

      if (netAmountRemaining >= maxAmountIn && maxAmountIn > 0n) {
        // Price reaches target boundary
        if (isArrayBoundary) {
          // Exceeds loaded tick arrays without completing swap -> fail closed
          this.lastFailureReason = 'MISSING_TICK_DATA';
          return null;
        }

        let stepAmountOut: bigint;
        if (zeroForOne) {
          stepAmountOut = tryGetAmountDeltaB(targetSqrtPrice, currentSqrtPrice, currentLiquidity, false);
        } else {
          stepAmountOut = tryGetAmountDeltaA(currentSqrtPrice, targetSqrtPrice, currentLiquidity, false);
        }

        totalAmountOut += stepAmountOut;
        netAmountRemaining -= maxAmountIn;
        currentSqrtPrice = targetSqrtPrice;

        // Cross tick: update active liquidity
        const crossingTick = relevantTicks[i];
        if (zeroForOne) {
          currentLiquidity -= crossingTick.liquidityNet;
          currentTick = targetTick - 1;
        } else {
          currentLiquidity += crossingTick.liquidityNet;
          currentTick = targetTick;
        }

        if (currentLiquidity <= 0n && netAmountRemaining > 0n) {
          this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
          return null;
        }
      } else {
        // Swap completes inside this tick range
        let nextSqrtPrice: bigint;
        let stepAmountOut: bigint;

        if (zeroForOne) {
          nextSqrtPrice = tryGetNextSqrtPriceFromA(currentSqrtPrice, currentLiquidity, netAmountRemaining, true);
          stepAmountOut = tryGetAmountDeltaB(nextSqrtPrice, currentSqrtPrice, currentLiquidity, false);
        } else {
          nextSqrtPrice = tryGetNextSqrtPriceFromB(currentSqrtPrice, currentLiquidity, netAmountRemaining, true);
          stepAmountOut = tryGetAmountDeltaA(currentSqrtPrice, nextSqrtPrice, currentLiquidity, false);
        }

        totalAmountOut += stepAmountOut;
        currentSqrtPrice = nextSqrtPrice;
        netAmountRemaining = 0n;
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
    if (netAmountIn > 0n && sqrtPrice > 0n) {
      let idealOut = 0n;
      if (zeroForOne) {
        // Token A -> Token B: idealOut = (netAmountIn * sqrtPrice^2) / 2^128
        idealOut = (netAmountIn * sqrtPrice * sqrtPrice) / Q128;
      } else {
        // Token B -> Token A: idealOut = (netAmountIn * 2^128) / (sqrtPrice^2)
        idealOut = (netAmountIn * Q128) / (sqrtPrice * sqrtPrice);
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
        effectiveFeePpm: feeRate
      }
    };
  }
}
