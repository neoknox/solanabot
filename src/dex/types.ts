import { DexType, PoolState, SwapQuote, RejectionReasonCode } from '../types/index.js';

export interface DexAdapter {
  readonly dex: DexType;
  readonly programId: string;

  decodePoolState(data: Buffer, poolId: string, slot: number): PoolState | null;

  quoteExactInput(
    pool: PoolState,
    inputMint: string,
    amountIn: bigint
  ): SwapQuote | null;

  getLastFailureReason?(): RejectionReasonCode | null;
}
