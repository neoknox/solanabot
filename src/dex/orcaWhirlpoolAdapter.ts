import { PublicKey } from '@solana/web3.js';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT } from '../config/index.js';

const Q64 = 1n << 64n;

export class OrcaWhirlpoolAdapter implements DexAdapter {
  public readonly dex: DexType = 'ORCA_WHIRLPOOL';
  public readonly programId: string = KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL;

  public decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null {
    if (data.length < 653) return null;

    try {
      const tickSpacing = data.readUInt16LE(41);
      const feeRateRaw = data.readUInt16LE(43); // hundredths of a basis point (e.g. 400 = 4 bps)
      const feeBps = Math.max(1, Math.round(feeRateRaw / 100));

      // Read liquidity (u128 at offset 49 or 47..63)
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

      const isBaseWSOL = tokenMintA === CANONICAL_WSOL_MINT;
      const tokenADecimals = isBaseWSOL ? 9 : 6;
      const tokenBDecimals = isBaseWSOL ? 6 : 9;

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
    if (amountIn <= 0n) return null;

    const extra = pool.extraData as {
      liquidity?: string;
      sqrtPrice?: string;
      feeRateRaw?: number;
    } | undefined;

    const liquidity = BigInt(extra?.liquidity || '0');
    const sqrtPrice = BigInt(extra?.sqrtPrice || '0');
    if (liquidity <= 0n || sqrtPrice <= 0n) {
      // If tick data not yet loaded or reserves available fallback to constant-product approx with pool reserves
      if ((pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n) {
        return this.quoteFromReserves(pool, inputMint, amountIn);
      }
      return null;
    }

    const isInputA = inputMint === pool.tokenAMint;
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    // Fee deduction (feeRateRaw is in 1/1,000,000, i.e. 100 = 1 bps)
    const feeRateRaw = BigInt(extra?.feeRateRaw ?? pool.feeBps * 100);
    const feeDenominator = 1000000n;
    const feeAmount = (amountIn * feeRateRaw) / feeDenominator;
    const amountInAfterFee = amountIn - feeAmount;

    if (amountInAfterFee <= 0n) return null;

    let amountOut = 0n;
    let priceImpactBps = 0;

    try {
      if (isInputA) {
        // Swapping Token A -> Token B (e.g. WSOL -> USDC)
        // Price decreases: sqrtPriceNew = (L * sqrtPrice) / (L + amountIn * sqrtPrice / Q64)
        const product = (amountInAfterFee * sqrtPrice) / Q64;
        const denominator = liquidity + product;
        if (denominator <= 0n) return null;

        const sqrtPriceNew = (liquidity * sqrtPrice) / denominator;
        const deltaSqrt = sqrtPrice - sqrtPriceNew;
        amountOut = (liquidity * deltaSqrt) / Q64;

        if (sqrtPrice > 0n) {
          priceImpactBps = Number(((sqrtPrice - sqrtPriceNew) * 20000n) / sqrtPrice);
        }
      } else {
        // Swapping Token B -> Token A (e.g. USDC -> WSOL)
        // Price increases: sqrtPriceNew = sqrtPrice + (amountIn * Q64) / L
        const deltaSqrt = (amountInAfterFee * Q64) / liquidity;
        const sqrtPriceNew = sqrtPrice + deltaSqrt;
        if (sqrtPriceNew <= 0n) return null;

        // amountOut = (L * deltaSqrt * Q64) / (sqrtPriceNew * sqrtPrice)
        const numerator = liquidity * deltaSqrt * Q64;
        const denominator = sqrtPriceNew * sqrtPrice;
        if (denominator <= 0n) return null;

        amountOut = numerator / denominator;
        if (sqrtPrice > 0n) {
          priceImpactBps = Number(((sqrtPriceNew - sqrtPrice) * 20000n) / sqrtPrice);
        }
      }
    } catch {
      return null;
    }

    if (amountOut <= 0n) return null;

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
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };
  }

  private quoteFromReserves(pool: PoolState, inputMint: string, amountIn: bigint): SwapQuote | null {
    const isInputA = inputMint === pool.tokenAMint;
    const reserveIn = isInputA ? (pool.reserveA ?? 0n) : (pool.reserveB ?? 0n);
    const reserveOut = isInputA ? (pool.reserveB ?? 0n) : (pool.reserveA ?? 0n);
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    if (reserveIn <= 0n || reserveOut <= 0n) return null;

    const feeDeduction = (amountIn * BigInt(pool.feeBps)) / 10000n;
    const inAfterFee = amountIn - feeDeduction;
    const outAmount = (reserveOut * inAfterFee) / (reserveIn + inAfterFee);

    if (outAmount <= 0n || outAmount >= reserveOut) return null;

    const priceImpactBps = Number((inAfterFee * 10000n) / (reserveIn + inAfterFee));

    return {
      quoteSource: 'DIRECT_POOL',
      poolId: pool.id,
      dex: this.dex,
      inputMint,
      outputMint,
      inAmount: amountIn,
      outAmount,
      feeIncluded: true,
      feeAmount: feeDeduction,
      priceImpactBps,
      slot: pool.slot,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };
  }
}
