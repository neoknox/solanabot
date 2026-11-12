import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT, getKnownTokenDecimals } from '../config/index.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_DOWN });

export class MeteoraDlmmAdapter implements DexAdapter {
  public readonly dex: DexType = 'METEORA_DLMM';
  public readonly programId: string = KNOWN_PROGRAM_IDS.METEORA_DLMM;

  public decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null {
    if (data.length < 904) return null;

    try {
      const binStep = data.readUInt16LE(8);
      const activeId = data.readInt32LE(76);

      const tokenXMint = new PublicKey(data.subarray(88, 120)).toBase58();
      const tokenYMint = new PublicKey(data.subarray(120, 152)).toBase58();
      const reserveX = new PublicKey(data.subarray(152, 184)).toBase58();
      const reserveY = new PublicKey(data.subarray(184, 216)).toBase58();

      const tokenADecimals = getKnownTokenDecimals(tokenXMint);
      const tokenBDecimals = getKnownTokenDecimals(tokenYMint);

      // Meteora DLMM base fee parameter
      const feeBps = Math.max(1, Math.min(100, Math.round(binStep / 10)));

      return {
        id: poolId,
        dex: this.dex,
        programId: this.programId,
        tokenAMint: tokenXMint,
        tokenBMint: tokenYMint,
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
          binStep,
          activeId,
          reserveX,
          reserveY,
          hasVerifiedBinArrays: false // Pending multi-bin account streaming
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
    if (!pool.receivedAt || pool.receivedAt <= 0) return null;

    const extra = pool.extraData as {
      binStep?: number;
      activeId?: number;
      binLiquidityX?: string;
      binLiquidityY?: string;
      hasVerifiedBinArrays?: boolean;
    } | undefined;

    const binStep = extra?.binStep;
    const activeId = extra?.activeId;
    const hasVerifiedBinArrays = extra?.hasVerifiedBinArrays === true;
    const binLiquidityX = extra?.binLiquidityX;
    const binLiquidityY = extra?.binLiquidityY;

    // Fail closed: As mandated by Phase 1.1 accuracy gate, in the absence of complete
    // verified bin arrays and explicit bin capacity data from RPC/SDK, mathematical approximations
    // (Math.pow, placeholder liquidity) are strictly prohibited. Missing bin arrays NEVER
    // produces a qualified direct quote.
    if (
      binStep === undefined ||
      activeId === undefined ||
      !hasVerifiedBinArrays ||
      !binLiquidityX ||
      !binLiquidityY
    ) {
      return null;
    }

    const isInputA = inputMint === pool.tokenAMint;
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    const feeAmount = (amountIn * BigInt(pool.feeBps)) / 10000n;
    const amountInAfterFee = amountIn - feeAmount;
    if (amountInAfterFee <= 0n) return null;

    try {
      // Check active bin reserve capacity
      const activeBinCapacity = isInputA
        ? BigInt(binLiquidityX)
        : BigInt(binLiquidityY);

      // If trade exceeds active bin capacity, multi-bin traversal across bin arrays is required.
      if (amountInAfterFee > activeBinCapacity) {
        return null;
      }

      // Exact high-precision price ratio using Decimal (50-digit precision):
      // P = (1 + binStep * 1e-4)^activeId
      const binStepDecimal = new Decimal(binStep).mul('0.0001').add(1);
      const rawPrice = binStepDecimal.pow(activeId);
      if (!rawPrice.isFinite() || rawPrice.lte(0)) {
        return null;
      }

      let amountOut: bigint;
      if (isInputA) {
        // Token X (WSOL) -> Token Y (USDC): amountOut = amountInAfterFee * rawPrice
        const outDecimal = new Decimal(amountInAfterFee.toString()).mul(rawPrice).floor();
        amountOut = BigInt(outDecimal.toFixed(0));
      } else {
        // Token Y (USDC) -> Token X (WSOL): amountOut = amountInAfterFee / rawPrice
        const outDecimal = new Decimal(amountInAfterFee.toString()).div(rawPrice).floor();
        amountOut = BigInt(outDecimal.toFixed(0));
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
        priceImpactBps: Math.min(pool.feeBps, 50),
        slot: pool.slot,
        timestamp: pool.receivedAt,
        executionType: 'POTENTIAL_ATOMIC'
      };
    } catch {
      return null;
    }
  }
}
