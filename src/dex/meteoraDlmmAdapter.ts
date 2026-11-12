import { PublicKey } from '@solana/web3.js';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT } from '../config/index.js';

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

      const isBaseWSOL = tokenXMint === CANONICAL_WSOL_MINT;
      const tokenADecimals = isBaseWSOL ? 9 : 6;
      const tokenBDecimals = isBaseWSOL ? 6 : 9;

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
          reserveY
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
      binStep?: number;
      activeId?: number;
      binLiquidityX?: string;
      binLiquidityY?: string;
    } | undefined;

    const binStep = extra?.binStep;
    const activeId = extra?.activeId;

    // Fail closed: require verified bin parameters
    if (binStep === undefined || activeId === undefined) {
      return null;
    }

    const isInputA = inputMint === pool.tokenAMint;
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    const feeAmount = (amountIn * BigInt(pool.feeBps)) / 10000n;
    const amountInAfterFee = amountIn - feeAmount;
    if (amountInAfterFee <= 0n) return null;

    try {
      // Bin price ratio: P = (1 + binStep * 1e-4)^activeId
      const binStepRatio = 1 + (binStep * 0.0001);
      const rawPrice = Math.pow(binStepRatio, activeId);
      if (isNaN(rawPrice) || rawPrice <= 0 || !isFinite(rawPrice)) {
        return null;
      }

      // Check active bin reserve capacity if available
      const activeBinResIn = isInputA
        ? (extra?.binLiquidityX ? BigInt(extra.binLiquidityX) : undefined)
        : (extra?.binLiquidityY ? BigInt(extra.binLiquidityY) : undefined);

      // If active bin capacity is known and trade exceeds it, bin-array traversal is required.
      // In the absence of complete multi-bin array state, fail closed to prevent assuming spot price = executable price.
      if (activeBinResIn !== undefined && amountInAfterFee > activeBinResIn) {
        return null;
      }

      let amountOut: bigint;
      if (isInputA) {
        // Token X (WSOL) -> Token Y (USDC): amountOut = amountIn * rawPrice
        const outNum = Number(amountInAfterFee) * rawPrice;
        amountOut = BigInt(Math.floor(outNum));
      } else {
        // Token Y (USDC) -> Token X (WSOL): amountOut = amountIn / rawPrice
        const outNum = Number(amountInAfterFee) / rawPrice;
        amountOut = BigInt(Math.floor(outNum));
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
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      };
    } catch {
      return null;
    }
  }
}
