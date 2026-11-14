import { PublicKey } from '@solana/web3.js';
import { KNOWN_PROGRAM_IDS } from '../config/index.js';

export const RAYDIUM_CLMM_TICK_ARRAY_SIZE = 60;
export const RAYDIUM_CLMM_TICK_STATE_SIZE = 168;
export const RAYDIUM_CLMM_TICK_ARRAY_ACCOUNT_SIZE = 10240;

export interface RaydiumClmmTickState {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  initialized: boolean;
}

export interface RaydiumClmmTickArray {
  poolId: string;
  startTickIndex: number;
  initializedTickCount: number;
  ticks: RaydiumClmmTickState[];
}

export interface CachedRaydiumClmmTickArray {
  startTickIndex: number;
  pda: string;
  array: RaydiumClmmTickArray;
  slot: number;
  receivedAt: number;
}

/**
 * Derives the PDA for a Raydium CLMM TickArray account.
 * Seed formula: ['tick_array', pool_id.toBuffer(), start_tick_index.toBE(4)]
 */
export function deriveRaydiumClmmTickArrayPda(
  poolId: string | PublicKey,
  startTickIndex: number,
  programId: string = KNOWN_PROGRAM_IDS.RAYDIUM_CLMM
): PublicKey {
  const poolPubkey = typeof poolId === 'string' ? new PublicKey(poolId) : poolId;
  const progPubkey = new PublicKey(programId);
  const startTickBuf = Buffer.alloc(4);
  startTickBuf.writeInt32BE(startTickIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('tick_array'),
      poolPubkey.toBuffer(),
      startTickBuf
    ],
    progPubkey
  );
  return pda;
}

/**
 * Calculates the start tick index of the tick array containing `tickIndex`.
 * tickIndex / (60 * tickSpacing) floored * (60 * tickSpacing).
 */
export function getRaydiumClmmArrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const ticksPerArray = RAYDIUM_CLMM_TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tickIndex / ticksPerArray) * ticksPerArray;
}

/**
 * Calculates the required 3 sequential tick array start indices for a swap direction.
 * When swapping A -> B (zeroForOne), price drops and ticks move down.
 * When swapping B -> A (oneForZero), price rises and ticks move up.
 */
export function getRequiredRaydiumClmmTickArrayStartIndices(
  tickCurrent: number,
  tickSpacing: number,
  direction: 'A_TO_B' | 'B_TO_A'
): number[] {
  const currentStart = getRaydiumClmmArrayStartIndex(tickCurrent, tickSpacing);
  const span = RAYDIUM_CLMM_TICK_ARRAY_SIZE * tickSpacing;
  if (direction === 'A_TO_B') {
    return [currentStart, currentStart - span, currentStart - 2 * span];
  } else {
    return [currentStart, currentStart + span, currentStart + 2 * span];
  }
}

/**
 * Calculates surrounding tick array start indices for background hydration and WebSocket subscription.
 * Returns the tick array containing current tick, one below, and one above.
 */
export function getSurroundingRaydiumClmmTickArrayStartIndices(
  tickCurrent: number,
  tickSpacing: number
): number[] {
  const currentStart = getRaydiumClmmArrayStartIndex(tickCurrent, tickSpacing);
  const span = RAYDIUM_CLMM_TICK_ARRAY_SIZE * tickSpacing;
  return [currentStart - span, currentStart, currentStart + span];
}

/**
 * Decodes a raw Solana account buffer into a validated RaydiumClmmTickArray.
 * Verifies account size (>= 10,240 bytes), pool ID match, and tick structure.
 */
export function decodeRaydiumClmmTickArray(
  data: Buffer,
  expectedPoolId?: string
): RaydiumClmmTickArray | null {
  if (data.length < RAYDIUM_CLMM_TICK_ARRAY_ACCOUNT_SIZE) return null;

  try {
    const poolId = new PublicKey(data.subarray(8, 40)).toBase58();
    if (expectedPoolId && poolId !== expectedPoolId) {
      return null;
    }

    const startTickIndex = data.readInt32LE(40);
    const initializedTickCount = data.readUInt8(10124);
    const ticks: RaydiumClmmTickState[] = [];
    let offset = 44;

    for (let i = 0; i < RAYDIUM_CLMM_TICK_ARRAY_SIZE; i++) {
      const tick = data.readInt32LE(offset);

      // liquidityNet: signed i128 (low 64 bits unsigned, high 64 bits signed)
      const lowNet = data.readBigUInt64LE(offset + 4);
      const highNet = data.readBigInt64LE(offset + 12);
      const liquidityNet = (highNet << 64n) | lowNet;

      // liquidityGross: unsigned u128 (low 64 bits unsigned, high 64 bits unsigned)
      const lowGross = data.readBigUInt64LE(offset + 20);
      const highGross = data.readBigUInt64LE(offset + 28);
      const liquidityGross = (highGross << 64n) | lowGross;

      ticks.push({
        tick,
        liquidityNet,
        liquidityGross,
        initialized: liquidityGross > 0n
      });

      offset += RAYDIUM_CLMM_TICK_STATE_SIZE;
    }

    return {
      poolId,
      startTickIndex,
      initializedTickCount,
      ticks
    };
  } catch {
    return null;
  }
}
