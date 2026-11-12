import { describe, it, expect } from 'vitest';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  KNOWN_TOKENS,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';
import { dexRegistry } from '../src/dex/index.js';

describe('Test Matrix 1 & 16: Tokens, Programs, and DEX Support Status', () => {
  it('Matrix 1.1: Validates canonical WSOL and USDC mints and decimals', () => {
    const wsol = KNOWN_TOKENS[CANONICAL_WSOL_MINT];
    const usdc = KNOWN_TOKENS[CANONICAL_USDC_MINT];

    expect(wsol).toBeDefined();
    expect(wsol.decimals).toBe(9);
    expect(wsol.symbol).toBe('WSOL');

    expect(usdc).toBeDefined();
    expect(usdc.decimals).toBe(6);
    expect(usdc.symbol).toBe('USDC');
  });

  it('Matrix 1.2: Rejects arbitrary / non-canonical token mints', () => {
    const fakeMint = 'FakeTokenMintAddress11111111111111111111111';
    expect(KNOWN_TOKENS[fakeMint]).toBeUndefined();
  });

  it('Matrix 1.3: Rejects invalid program IDs in DEX adapters', () => {
    const fakeProgramId = 'FakeProgramId111111111111111111111111111111';
    const adapter = dexRegistry.getAdapterByProgramId(fakeProgramId);
    expect(adapter).toBeUndefined();
  });

  it('Matrix 16.1: Accurately reports DEX support status (direct vs discovered vs unsupported)', () => {
    expect(dexRegistry.getSupportStatus('RAYDIUM_AMM')).toBe('DIRECT_SUPPORTED');
    expect(dexRegistry.getSupportStatus('ORCA_WHIRLPOOL')).toBe('DIRECT_SUPPORTED');
    expect(dexRegistry.getSupportStatus('METEORA_DLMM')).toBe('DIRECT_SUPPORTED');

    expect(dexRegistry.getSupportStatus('PHOENIX')).toBe('JUPITER_BUILD_METIS');
    expect(dexRegistry.getSupportStatus('RAYDIUM_CLMM')).toBe('JUPITER_BUILD_METIS');

    expect(dexRegistry.getSupportStatus('ZERO_FI')).toBe('PROPRIETARY_RESTRICTED');
    expect(dexRegistry.getSupportStatus('HUMIDI_FI')).toBe('PROPRIETARY_RESTRICTED');
    expect(dexRegistry.getSupportStatus('SOL_FI')).toBe('PROPRIETARY_RESTRICTED');

    expect(dexRegistry.getSupportStatus('UNKNOWN')).toBe('UNSUPPORTED');
  });
});
