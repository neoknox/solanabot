import { PublicKey } from '@solana/web3.js';
import { KNOWN_PROGRAM_IDS } from '../config/index.js';

export const RAYDIUM_CLMM_AMM_CONFIG_SIZE = 117;
export const RAYDIUM_CLMM_AMM_CONFIG_DISCRIMINATOR = 'daf42168cbcb2b6f';

export interface RaydiumClmmAmmConfig {
  id: string; // AmmConfig account address (Base58)
  bump: number;
  index: number;
  owner: string; // Admin owner Pubkey
  protocolFeeRate: number; // in ppm (10^-6)
  tradeFeeRate: number; // in ppm (10^-6), e.g. 100 = 1 bps, 200 = 2 bps, 500 = 5 bps, 2500 = 25 bps, 10000 = 100 bps
  tickSpacing: number;
  fundFeeRate: number; // in ppm (10^-6)
  fundOwner: string;
  slot: number;
  receivedAt: number;
}

/**
 * Decodes a raw Solana account buffer into a validated RaydiumClmmAmmConfig.
 * Validates:
 * 1. Account data length >= 117 bytes
 * 2. Anchor discriminator matches 'daf42168cbcb2b6f'
 * 3. On-chain program owner (if passed) matches KNOWN_PROGRAM_IDS.RAYDIUM_CLMM
 */
export function decodeRaydiumClmmAmmConfig(
  data: Buffer,
  accountId: string,
  slot: number,
  receivedAt: number = Date.now(),
  ownerProgram?: string
): RaydiumClmmAmmConfig | null {
  if (data.length < RAYDIUM_CLMM_AMM_CONFIG_SIZE) return null;

  if (ownerProgram && ownerProgram !== KNOWN_PROGRAM_IDS.RAYDIUM_CLMM) {
    return null;
  }

  try {
    const discriminator = data.subarray(0, 8).toString('hex');
    if (discriminator !== RAYDIUM_CLMM_AMM_CONFIG_DISCRIMINATOR) {
      return null;
    }

    const bump = data.readUInt8(8);
    const index = data.readUInt16LE(9);
    const owner = new PublicKey(data.subarray(11, 43)).toBase58();
    const protocolFeeRate = data.readUInt32LE(43);
    const tradeFeeRate = data.readUInt32LE(47);
    const tickSpacing = data.readUInt16LE(51);
    const fundFeeRate = data.readUInt32LE(53);
    const fundOwner = new PublicKey(data.subarray(57, 89)).toBase58();

    // Strict sanity checks on decoded numeric parameters
    if (
      !Number.isInteger(tradeFeeRate) ||
      tradeFeeRate < 0 ||
      tradeFeeRate >= 1_000_000 ||
      tickSpacing === 0 ||
      protocolFeeRate > 1_000_000 ||
      fundFeeRate > 1_000_000
    ) {
      return null;
    }

    return {
      id: accountId,
      bump,
      index,
      owner,
      protocolFeeRate,
      tradeFeeRate,
      tickSpacing,
      fundFeeRate,
      fundOwner,
      slot,
      receivedAt
    };
  } catch {
    return null;
  }
}
