import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote, RejectionReasonCode } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT, getKnownTokenDecimals } from '../config/index.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_DOWN });

const Q64 = 1n << 64n;

/**
 * Converts tick index to sqrtPriceX64 using 50-digit precision Decimal arithmetic,
 * eliminating IEEE 754 floating-point drift from Math.pow(1.0001, tick/2).
 */
export function tickIndexToSqrtPriceX64(tickIndex: number): bigint {
  const q64 = new Decimal(2).pow(64);
  const sqrtPrice = new Decimal(1.0001).pow(new Decimal(tickIndex).div(2)).mul(q64).floor();
  return BigInt(sqrtPrice.toFixed(0));
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
      const feeRateRaw = data.readUInt16LE(43); // hundredths of a basis point (e.g. 400 = 4 bps)
      const feeBps = Math.max(1, Math.round(feeRateRaw / 100));

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
          feeRateRaw,
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
      feeRateRaw?: number;
      tickCurrent?: number;
      tickSpacing?: number;
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

    // Adaptive fee deduction (feeRateRaw is in hundredths of bps: 100 = 1 bps, 1,000,000 = 100%)
    const feeRateRaw = BigInt(extra?.feeRateRaw ?? pool.feeBps * 100);
    const feeDenominator = 1000000n;
    const feeAmount = (amountIn * feeRateRaw) / feeDenominator;
    const amountInAfterFee = amountIn - feeAmount;

    if (amountInAfterFee <= 0n) {
      this.lastFailureReason = 'EXCESSIVE_PRICE_IMPACT';
      return null;
    }

    // Boundary check: Verify whether trade exceeds the current initialized tick range
    // If trade crosses the boundary, tick arrays are required. If tick arrays are incomplete, fail closed.
    let amountOut = 0n;
    let priceImpactBps = 0;

    try {
      if (isInputA) {
        // Swapping Token A -> Token B (WSOL -> USDC): price moves down towards lower tick boundary
        const nextLowerTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
        const sqrtPriceTarget = tickIndexToSqrtPriceX64(nextLowerTick);

        if (sqrtPriceTarget < sqrtPrice) {
          const deltaSqrt = sqrtPrice - sqrtPriceTarget;
          const maxInA = (liquidity * deltaSqrt * Q64) / (sqrtPrice * sqrtPriceTarget);
          // If input exceeds active tick capacity and full tick-array traversal is not loaded, reject unverified quote
          if (amountInAfterFee > maxInA && maxInA > 0n) {
            // Proven tick array boundary exceeded without verified tick array state
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
        const sqrtPriceTarget = tickIndexToSqrtPriceX64(nextUpperTick);

        if (sqrtPriceTarget > sqrtPrice) {
          const deltaSqrt = sqrtPriceTarget - sqrtPrice;
          const maxInB = (liquidity * deltaSqrt) / Q64;
          // If input exceeds active tick capacity, reject unverified quote without tick arrays
          if (amountInAfterFee > maxInB && maxInB > 0n) {
            // Proven tick array boundary exceeded without verified tick array state
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
