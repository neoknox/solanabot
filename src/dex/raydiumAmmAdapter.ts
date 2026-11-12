import { PublicKey } from '@solana/web3.js';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../config/index.js';

export class RaydiumAmmAdapter implements DexAdapter {
  public readonly dex: DexType = 'RAYDIUM_AMM';
  public readonly programId: string = KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4;

  public decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null {
    if (data.length < 752) return null;

    try {
      const swapFeeNumerator = data.readBigUInt64LE(176);
      const swapFeeDenominator = data.readBigUInt64LE(184);

      const baseVault = new PublicKey(data.subarray(336, 368)).toBase58();
      const quoteVault = new PublicKey(data.subarray(368, 400)).toBase58();
      const baseMint = new PublicKey(data.subarray(400, 432)).toBase58();
      const quoteMint = new PublicKey(data.subarray(432, 464)).toBase58();

      const feeBps = swapFeeDenominator > 0n
        ? Number((swapFeeNumerator * 10000n) / swapFeeDenominator)
        : 25;

      const isBaseWSOL = baseMint === CANONICAL_WSOL_MINT;
      const tokenADecimals = isBaseWSOL ? 9 : 6;
      const tokenBDecimals = isBaseWSOL ? 6 : 9;

      return {
        id: poolId,
        dex: this.dex,
        programId: this.programId,
        tokenAMint: baseMint,
        tokenBMint: quoteMint,
        tokenADecimals,
        tokenBDecimals,
        reserveA: 0n, // Updated dynamically from token vaults
        reserveB: 0n,
        feeBps,
        slot,
        receivedAt: Date.now(),
        liquidityUsd: 0,
        feedHealth: 'HEALTHY',
        extraData: {
          baseVault,
          quoteVault,
          swapFeeNumerator: swapFeeNumerator.toString(),
          swapFeeDenominator: swapFeeDenominator.toString()
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

    const reserveA = pool.reserveA ?? 0n;
    const reserveB = pool.reserveB ?? 0n;
    if (reserveA <= 0n || reserveB <= 0n) return null;

    const isInputA = inputMint === pool.tokenAMint;
    const reserveIn = isInputA ? reserveA : reserveB;
    const reserveOut = isInputA ? reserveB : reserveA;
    const outputMint = isInputA ? pool.tokenBMint : pool.tokenAMint;

    const feeNumerator = BigInt(pool.feeBps);
    const feeDenominator = 10000n;
    const feeDeduction = (amountIn * feeNumerator) / feeDenominator;
    const amountInAfterFee = amountIn - feeDeduction;

    if (amountInAfterFee <= 0n) return null;

    // Standard constant product AMM formula: amountOut = (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee)
    const numerator = reserveOut * amountInAfterFee;
    const denominator = reserveIn + amountInAfterFee;
    const amountOut = numerator / denominator;

    if (amountOut <= 0n || amountOut >= reserveOut) return null;

    // Exact price impact: (amountInWithFee * 10000) / (reserveIn + amountInWithFee)
    const priceImpactBps = Number((amountInAfterFee * 10000n) / denominator);

    return {
      quoteSource: 'DIRECT_POOL',
      poolId: pool.id,
      dex: this.dex,
      inputMint,
      outputMint,
      inAmount: amountIn,
      outAmount: amountOut,
      feeIncluded: true,
      feeAmount: feeDeduction,
      priceImpactBps,
      slot: pool.slot,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };
  }
}
