import { PublicKey } from '@solana/web3.js';
import {
  tickIndexToSqrtPrice,
  swapQuoteByInputToken,
  WhirlpoolFacade,
  TickArrayFacade
} from '@orca-so/whirlpools-core';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote, RejectionReasonCode } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT, getKnownTokenDecimals } from '../config/index.js';
import { getRequiredTickArrayStartIndices } from './orcaTickArray.js';

const Q64 = 1n << 64n;

/**
 * Converts tick index to sqrtPriceX64 using official Orca Whirlpool core integer math,
 * providing zero-drift exact parity with on-chain smart contract math.
 */
export function tickIndexToSqrtPriceX64(tickIndex: number): bigint {
  return tickIndexToSqrtPrice(tickIndex);
}

export class OrcaWhirlpoolAdapter implements DexAdapter {
  public readonly dex: DexType = 'ORCA_WHIRLPOOL';
  public readonly programId: string = KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL;

  private lastFailureReason: RejectionReasonCode | null = null;

  public getLastFailureReason(): RejectionReasonCode | null {
    return this.lastFailureReason;
  }

  public decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null {
    if (data.length < 653) return null;

    try {
      const tickSpacing = data.readUInt16LE(41);
      const feeTierIndexSeed = [data.readUInt8(43), data.readUInt8(44)];
      const feeRate = data.readUInt16LE(45); // hundredths of a basis point (e.g. 400 = 4 bps)
      const protocolFeeRate = data.readUInt16LE(47);
      const feeBps = Math.max(1, Math.round(feeRate / 100));

      // Read liquidity (u128 at offset 49..65)
      const liquidityLow = data.readBigUInt64LE(49);
      const liquidityHigh = data.readBigUInt64LE(57);
      const liquidity = (liquidityHigh << 64n) | liquidityLow;

      // Read sqrtPrice (u128 at offset 65..81)
      const sqrtPriceLow = data.readBigUInt64LE(65);
      const sqrtPriceHigh = data.readBigUInt64LE(73);
      const sqrtPrice = (sqrtPriceHigh << 64n) | sqrtPriceLow;

      const tickCurrent = data.readInt32LE(81);

      const tokenMintA = new PublicKey(data.subarray(101, 133)).toBase58();
      const tokenVaultA = new PublicKey(data.subarray(133, 165)).toBase58();
      const tokenMintB = new PublicKey(data.subarray(181, 213)).toBase58();
      const tokenVaultB = new PublicKey(data.subarray(213, 245)).toBase58();

      const tokenADecimals = getKnownTokenDecimals(tokenMintA);
      const tokenBDecimals = getKnownTokenDecimals(tokenMintB);

      return {
        id: poolId,
        dex: this.dex,
        programId: this.programId,
        tokenAMint: tokenMintA,
        tokenBMint: tokenMintB,
        tokenADecimals,
        tokenBDecimals,
        reserveA: 0n,
        reserveB: 0n,
        feeBps,
        slot,
        receivedAt: Date.now(),
        liquidityUsd: 0,
        feedHealth: 'HEALTHY',
        extraData: {
          tickSpacing,
          feeTierIndexSeed,
          feeRate,
          protocolFeeRate,
          feeRateRaw: feeRate,
          liquidity: liquidity.toString(),
          sqrtPrice: sqrtPrice.toString(),
          tickCurrent,
          tokenVaultA,
          tokenVaultB
        }
      };
    } catch {
      return null;
    }
  }

  public quoteExactInput(
    pool: PoolState,
    inputMint: string,
    amountIn: bigint
  ): SwapQuote | null {
    if (amountIn <= 0n) {
      this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
      return null;
    }
    if (!pool.receivedAt || pool.receivedAt <= 0) {
      this.lastFailureReason = 'STALE_QUOTE';
      return null;
    }

    if (inputMint !== pool.tokenAMint && inputMint !== pool.tokenBMint) {
      this.lastFailureReason = 'INVALID_MINT';
      return null;
    }

    const extra = pool.extraData as {
      liquidity?: string;
      sqrtPrice?: string;
      feeRate?: number;
      feeRateRaw?: number;
      protocolFeeRate?: number;
      feeTierIndexSeed?: number[];
      tickCurrent?: number;
      tickSpacing?: number;
      tickArrays?: Record<number, TickArrayFacade>;
    } | undefined;

    const liquidity = BigInt(extra?.liquidity || '0');
    const sqrtPrice = BigInt(extra?.sqrtPrice || '0');
    const tickCurrent = extra?.tickCurrent;
    const tickSpacing = extra?.tickSpacing || 1;

    // Fail closed if pool concentrated liquidity parameters are missing or zero
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
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    // Multi-Tick Quoting: Check if verified tick arrays are loaded for this pool
    const loadedTickArrays = extra?.tickArrays;
    const direction = isInputA ? 'A_TO_B' : 'B_TO_A';
    const requiredStartIndices = getRequiredTickArrayStartIndices(tickCurrent, tickSpacing, direction);

    const getTickArray = (idx: number): TickArrayFacade | undefined => {
      if (!loadedTickArrays) return undefined;
      if (loadedTickArrays instanceof Map) return loadedTickArrays.get(idx);
      return loadedTickArrays[idx];
    };

    let hasAllRequiredArrays = false;
    const sequenceArrays: TickArrayFacade[] = [];

    if (loadedTickArrays) {
      hasAllRequiredArrays = requiredStartIndices.every(idx => !!getTickArray(idx));
      if (!hasAllRequiredArrays) {
        this.lastFailureReason = 'MISSING_TICK_DATA';
        return null;
      }

      // Independent Freshness: Validate observation freshness of required tick arrays
      const now = Date.now();
      const ttl = (extra as any)?.observationFreshnessTtlMs || 30000;
      const arrayTimestamps = (extra as any)?.tickArrayReceivedAt;
      const arraySlots = (extra as any)?.tickArraySlots;
      if (arrayTimestamps || arraySlots) {
        for (const idx of requiredStartIndices) {
          const t = arrayTimestamps?.[idx];
          const s = arraySlots?.[idx];
          if (!t || t <= 0 || !s || s <= 0) {
            this.lastFailureReason = 'MISSING_TICK_DATA';
            return null;
          }
          if (t > now + 5000 || now - t > ttl) {
            this.lastFailureReason = 'STALE_QUOTE';
            return null;
          }
          if (pool.slot && s && Math.abs(pool.slot - s) > 100) {
            this.lastFailureReason = 'SLOT_MISMATCH';
            return null;
          }
        }
      }

      for (const idx of requiredStartIndices) {
        const arr = getTickArray(idx);
        if (arr) sequenceArrays.push(arr);
      }
    }

    if (hasAllRequiredArrays && sequenceArrays.length === 3) {
      try {
        const seed = extra?.feeTierIndexSeed ? new Uint8Array(extra.feeTierIndexSeed) : new Uint8Array([tickSpacing, 0]);
        const whirlpoolFacade: WhirlpoolFacade = {
          feeTierIndexSeed: seed,
          tickSpacing,
          feeRate: extra?.feeRate ?? extra?.feeRateRaw ?? pool.feeBps * 100,
          protocolFeeRate: extra?.protocolFeeRate ?? 0,
          liquidity,
          sqrtPrice,
          tickCurrentIndex: tickCurrent,
          feeGrowthGlobalA: 0n,
          feeGrowthGlobalB: 0n,
          rewardLastUpdatedTimestamp: 0n,
          rewardInfos: [
            { emissionsPerSecondX64: 0n, growthGlobalX64: 0n },
            { emissionsPerSecondX64: 0n, growthGlobalX64: 0n },
            { emissionsPerSecondX64: 0n, growthGlobalX64: 0n }
          ]
        };

        const quoteRes = swapQuoteByInputToken(
          amountIn,
          isInputA,
          0,
          whirlpoolFacade,
          null,
          sequenceArrays,
          BigInt(Math.floor(Date.now() / 1000))
        );

        if (quoteRes.tokenEstOut <= 0n) {
          this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
          return null;
        }

        // Protocol-correct effective price impact calculation:
        // Compares post-fee actual output against instantaneous marginal output at starting spot price.
        const netAmountIn = amountIn - quoteRes.tradeFee;
        let priceImpactBps = 0;
        if (netAmountIn > 0n && sqrtPrice > 0n) {
          const Q128 = 1n << 128n;
          let idealOut = 0n;
          if (isInputA) {
            // Token A -> Token B: idealOut = (netAmountIn * sqrtPrice^2) / 2^128
            idealOut = (netAmountIn * sqrtPrice * sqrtPrice) / Q128;
          } else {
            // Token B -> Token A: idealOut = (netAmountIn * 2^128) / (sqrtPrice^2)
            idealOut = (netAmountIn * Q128) / (sqrtPrice * sqrtPrice);
          }

          if (idealOut > 0n) {
            const diff = idealOut > quoteRes.tokenEstOut ? idealOut - quoteRes.tokenEstOut : 0n;
            priceImpactBps = Number((diff * 10000n) / idealOut);
          } else {
            this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
            return null;
          }
        } else {
          this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
          return null;
        }

        const maxPriceImpactBps = (extra as any)?.maxPriceImpactBps ?? 200;
        if (priceImpactBps > maxPriceImpactBps) {
          this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
          return null;
        }

        this.lastFailureReason = null;
        return {
          quoteSource: 'DIRECT_POOL',
          poolId: pool.id,
          dex: this.dex,
          inputMint,
          outputMint,
          inAmount: amountIn,
          outAmount: quoteRes.tokenEstOut,
          feeIncluded: true,
          feeAmount: quoteRes.tradeFee,
          priceImpactBps,
          slot: pool.slot,
          timestamp: pool.receivedAt,
          executionType: 'POTENTIAL_ATOMIC'
        };
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes('TickArraySequence') || msg.includes('tick index not in array') || msg.includes('exceeded')) {
          this.lastFailureReason = 'TICK_BOUNDARY_EXCEEDED';
        } else {
          this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
        }
        return null;
      }
    }

    // Single-tick fallback: When multi-tick arrays are not yet prehydrated,
    // evaluate whether the probe fits safely inside the current active tick range.
    const feeRateRaw = BigInt(extra?.feeRate ?? extra?.feeRateRaw ?? pool.feeBps * 100);
    const feeDenominator = 1000000n;
    const feeAmount = (amountIn * feeRateRaw) / feeDenominator;
    const amountInAfterFee = amountIn - feeAmount;

    if (amountInAfterFee <= 0n) {
      this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
      return null;
    }

    let amountOut = 0n;
    let priceImpactBps = 0;

    try {
      if (isInputA) {
        // Swapping Token A -> Token B (WSOL -> USDC): price moves down towards lower tick boundary
        const nextLowerTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
        const sqrtPriceTarget = tickIndexToSqrtPrice(nextLowerTick);

        if (sqrtPriceTarget < sqrtPrice) {
          const deltaSqrt = sqrtPrice - sqrtPriceTarget;
          const maxInA = (liquidity * deltaSqrt * Q64) / (sqrtPrice * sqrtPriceTarget);
          if (amountInAfterFee > maxInA && maxInA > 0n) {
            this.lastFailureReason = 'TICK_BOUNDARY_EXCEEDED';
            return null;
          }
        }

        // Exact concentrated liquidity math within active tick:
        // sqrtPriceNew = (L * sqrtPrice) / (L + amountIn * sqrtPrice / Q64)
        const product = (amountInAfterFee * sqrtPrice) / Q64;
        const denominator = liquidity + product;
        if (denominator <= 0n) {
          this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
          return null;
        }

        const sqrtPriceNew = (liquidity * sqrtPrice) / denominator;
        const deltaSqrt = sqrtPrice - sqrtPriceNew;
        amountOut = (liquidity * deltaSqrt) / Q64;

        if (sqrtPrice > 0n) {
          priceImpactBps = Number(((sqrtPrice - sqrtPriceNew) * 20000n) / sqrtPrice);
        }
      } else {
        // Swapping Token B -> Token A (USDC -> WSOL): price moves up towards upper tick boundary
        const nextUpperTick = (Math.floor(tickCurrent / tickSpacing) + 1) * tickSpacing;
        const sqrtPriceTarget = tickIndexToSqrtPrice(nextUpperTick);

        if (sqrtPriceTarget > sqrtPrice) {
          const deltaSqrt = sqrtPriceTarget - sqrtPrice;
          const maxInB = (liquidity * deltaSqrt) / Q64;
          if (amountInAfterFee > maxInB && maxInB > 0n) {
            this.lastFailureReason = 'TICK_BOUNDARY_EXCEEDED';
            return null;
          }
        }

        // Exact concentrated liquidity math within active tick:
        // sqrtPriceNew = sqrtPrice + (amountIn * Q64) / L
        const deltaSqrt = (amountInAfterFee * Q64) / liquidity;
        const sqrtPriceNew = sqrtPrice + deltaSqrt;
        if (sqrtPriceNew <= 0n) {
          this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
          return null;
        }

        const numerator = liquidity * deltaSqrt * Q64;
        const denominator = sqrtPriceNew * sqrtPrice;
        if (denominator <= 0n) {
          this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
          return null;
        }

        amountOut = numerator / denominator;
        if (sqrtPrice > 0n) {
          priceImpactBps = Number(((sqrtPriceNew - sqrtPrice) * 20000n) / sqrtPrice);
        }
      }
    } catch {
      this.lastFailureReason = 'QUOTE_UNVERIFIED';
      return null;
    }

    if (amountOut <= 0n) {
      this.lastFailureReason = 'INSUFFICIENT_LIQUIDITY';
      return null;
    }

    const maxPriceImpactBps = (extra as any)?.maxPriceImpactBps ?? 200;
    if (priceImpactBps > maxPriceImpactBps) {
      this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
      return null;
    }

    this.lastFailureReason = null;
    return {
      quoteSource: 'DIRECT_POOL',
      poolId: pool.id,
      dex: this.dex,
      inputMint,
      outputMint,
      inAmount: amountIn,
      outAmount: amountOut,
      feeIncluded: true,
      feeAmount,
      priceImpactBps: Math.max(0, priceImpactBps),
      slot: pool.slot,
      timestamp: pool.receivedAt,
      executionType: 'POTENTIAL_ATOMIC'
    };
  }
}
