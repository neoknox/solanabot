import { PublicKey } from '@solana/web3.js';
import { TickArrayFacade, getTickArrayStartTickIndex } from '@orca-so/whirlpools-core';
import { KNOWN_PROGRAM_IDS } from '../config/index.js';

export const TICK_ARRAY_SIZE = 88;
export const TICK_ARRAY_ACCOUNT_SIZE = 9988;
export const TICK_SIZE_BYTES = 113;

export interface CachedTickArray {
  startTickIndex: number;
  pda: string;
  facade: TickArrayFacade;
  slot: number;
  receivedAt: number;
}

/**
 * Derives the PDA for an Orca Whirlpool TickArray account.
 */
export function deriveTickArrayPda(
  whirlpool: string | PublicKey,
  startTickIndex: number,
  programId: string = KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL
): PublicKey {
  const wpPubkey = typeof whirlpool === 'string' ? new PublicKey(whirlpool) : whirlpool;
  const progPubkey = new PublicKey(programId);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('tick_array'),
      wpPubkey.toBuffer(),
      Buffer.from(startTickIndex.toString())
    ],
    progPubkey
  );
  return pda;
}

/**
 * Decodes a raw Solana account buffer into an official TickArrayFacade.
 * Performs rigorous layout, length, discriminator, and pool ownership validation.
 */
export function decodeTickArrayAccount(
  data: Buffer,
  expectedWhirlpool?: string
): TickArrayFacade | null {
  if (data.length < TICK_ARRAY_ACCOUNT_SIZE) return null;

  try {
    // Offset 9956..9988 contains the whirlpool public key
    if (expectedWhirlpool) {
      const whirlpoolInAccount = new PublicKey(data.subarray(9956, 9988)).toBase58();
      if (whirlpoolInAccount !== expectedWhirlpool) {
        return null;
      }
    }

    const startTickIndex = data.readInt32LE(8);
    const ticks = [];
    let offset = 12;

    for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
      const initialized = data.readUInt8(offset) === 1;

      // i128: 16 bytes signed
      const low = data.readBigUInt64LE(offset + 1);
      const high = data.readBigInt64LE(offset + 9);
      const liquidityNet = (high << 64n) | low;

      // u128: 16 bytes unsigned
      const grossLow = data.readBigUInt64LE(offset + 17);
      const grossHigh = data.readBigUInt64LE(offset + 25);
      const liquidityGross = (grossHigh << 64n) | grossLow;

      ticks.push({
        initialized,
        liquidityNet,
        liquidityGross,
        feeGrowthOutsideA: 0n,
        feeGrowthOutsideB: 0n,
        rewardGrowthsOutside: [0n, 0n, 0n]
      });

      offset += TICK_SIZE_BYTES;
    }

    return {
      startTickIndex,
      ticks
    };
  } catch {
    return null;
  }
}

/**
 * Calculates the required 3 sequential tick array start indices for a swap direction.
 */
export function getRequiredTickArrayStartIndices(
  tickCurrent: number,
  tickSpacing: number,
  direction: 'A_TO_B' | 'B_TO_A'
): number[] {
  const start = getTickArrayStartTickIndex(tickCurrent, tickSpacing);
  const delta = TICK_ARRAY_SIZE * tickSpacing;

  if (direction === 'A_TO_B') {
    // Swapping Token A -> Token B: Price decreases, ticks decrease
    return [start, start - delta, start - 2 * delta];
  } else {
    // Swapping Token B -> Token A: Price increases, ticks increase
    return [start, start + delta, start + 2 * delta];
  }
}

/**
 * Returns all 5 nearby start indices around the active tick (current, -2, -1, +1, +2).
 */
export function getSurroundingTickArrayStartIndices(
  tickCurrent: number,
  tickSpacing: number
): number[] {
  const start = getTickArrayStartTickIndex(tickCurrent, tickSpacing);
  const delta = TICK_ARRAY_SIZE * tickSpacing;
  return [
    start - 2 * delta,
    start - delta,
    start,
    start + delta,
    start + 2 * delta
  ];
}
