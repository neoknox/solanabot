import { PublicKey } from '@solana/web3.js';
import { DexAdapter } from './types.js';
import { DexType, PoolState, SwapQuote } from '../types/index.js';
import { KNOWN_PROGRAM_IDS, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, getKnownTokenDecimals } from '../config/index.js';

export class RaydiumAmmAdapter implements DexAdapter {
  public readonly dex: DexType = 'RAYDIUM_AMM';
  public readonly programId: string = KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4;

  public decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null {
    if (data.length < 752) return null;

    try {
      const swapFeeNumerator = data.readBigUInt64LE(176);
      const swapFeeDenominator = data.readBigUInt64LE(184);
      const baseNeedTakePnl = data.readBigUInt64LE(192);
      const quoteNeedTakePnl = data.readBigUInt64LE(200);

      const baseVault = new PublicKey(data.subarray(336, 368)).toBase58();
      const quoteVault = new PublicKey(data.subarray(368, 400)).toBase58();
      const baseMint = new PublicKey(data.subarray(400, 432)).toBase58();
      const quoteMint = new PublicKey(data.subarray(432, 464)).toBase58();
      const openOrders = new PublicKey(data.subarray(496, 528)).toBase58();
      const marketId = new PublicKey(data.subarray(528, 560)).toBase58();
      const marketProgramId = new PublicKey(data.subarray(560, 592)).toBase58();

      const feeBps = swapFeeDenominator > 0n
        ? Number((swapFeeNumerator * 10000n) / swapFeeDenominator)
        : 25;

      const tokenADecimals = getKnownTokenDecimals(baseMint);
      const tokenBDecimals = getKnownTokenDecimals(quoteMint);

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
          openOrders,
          marketId,
          marketProgramId,
          baseNeedTakePnl: baseNeedTakePnl.toString(),
          quoteNeedTakePnl: quoteNeedTakePnl.toString(),
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
    if (!pool.receivedAt || pool.receivedAt <= 0) return null;

    const rawReserveA = pool.reserveA ?? 0n;
    const rawReserveB = pool.reserveB ?? 0n;
    if (rawReserveA <= 0n || rawReserveB <= 0n) return null;

    const extra = pool.extraData as {
      baseNeedTakePnl?: string;
      quoteNeedTakePnl?: string;
      openOrdersVerified?: boolean;
      openOrdersBaseTokenTotal?: string;
      openOrdersQuoteTokenTotal?: string;
    } | undefined;

    const basePnl = BigInt(extra?.baseNeedTakePnl || '0');
    const quotePnl = BigInt(extra?.quoteNeedTakePnl || '0');
    const openOrdersBase = BigInt(extra?.openOrdersBaseTokenTotal || '0');
    const openOrdersQuote = BigInt(extra?.openOrdersQuoteTokenTotal || '0');
    const isOpenOrdersVerified = extra?.openOrdersVerified === true;

    // Classic Raydium V4 reserve formula verified against official Raydium SDK source:
    // Effective reserve = vault balance + OpenOrders token total - uncollected accrued protocol PnL
    const totalRawA = rawReserveA + openOrdersBase;
    const totalRawB = rawReserveB + openOrdersQuote;
    const reserveA = totalRawA > basePnl ? totalRawA - basePnl : 0n;
    const reserveB = totalRawB > quotePnl ? totalRawB - quotePnl : 0n;
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

    const quote: SwapQuote = {
      quoteSource: isOpenOrdersVerified ? 'DIRECT_POOL' : 'UNVERIFIED',
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
      timestamp: pool.receivedAt,
      executionType: isOpenOrdersVerified ? 'POTENTIAL_ATOMIC' : 'INDICATIVE_ONLY'
    };

    if (!isOpenOrdersVerified) {
      (quote as any).isUnverified = true;
      (quote as any).unverifiedReason = 'BLOCKED_RPC_TIMEOUT';
    }

    return quote;
  }
}
