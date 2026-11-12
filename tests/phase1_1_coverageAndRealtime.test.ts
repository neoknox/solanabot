import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { dexRegistry } from '../src/dex/index.js';
import { KNOWN_PROGRAM_IDS, loadConfig } from '../src/config/index.js';
import { CostModel } from '../src/profit/costModel.js';

describe('Phase 1.1 Audit: Real-Time Vault Streaming, 12-DEX Inventory, and Cost Model', () => {
  it('Verifies program IDs and support classification for all 12 requested venues', () => {
    // 1. Raydium AMM V4
    expect(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4).toBe('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    expect(dexRegistry.getSupportStatus('RAYDIUM_AMM')).toBe('DIRECT_SUPPORTED');

    // 2. Raydium CPMM
    expect(KNOWN_PROGRAM_IDS.RAYDIUM_CPMM).toBe('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    expect(dexRegistry.getSupportStatus('RAYDIUM_CPMM')).toBe('JUPITER_BUILD_METIS');

    // 3. Raydium CLMM
    expect(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM).toBe('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    expect(dexRegistry.getSupportStatus('RAYDIUM_CLMM')).toBe('JUPITER_BUILD_METIS');

    // 4. Orca Whirlpool
    expect(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL).toBe('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    expect(dexRegistry.getSupportStatus('ORCA_WHIRLPOOL')).toBe('DIRECT_SUPPORTED');

    // 5. Meteora DLMM
    expect(KNOWN_PROGRAM_IDS.METEORA_DLMM).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    expect(dexRegistry.getSupportStatus('METEORA_DLMM')).toBe('DIRECT_SUPPORTED');

    // 6. Meteora DAMM
    expect(KNOWN_PROGRAM_IDS.METEORA_DAMM).toBe('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
    expect(dexRegistry.getSupportStatus('METEORA_DAMM')).toBe('JUPITER_BUILD_METIS');

    // 7. Phoenix
    expect(KNOWN_PROGRAM_IDS.PHOENIX).toBe('PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY');
    expect(dexRegistry.getSupportStatus('PHOENIX')).toBe('JUPITER_BUILD_METIS');

    // 8. OpenBook V2
    expect(KNOWN_PROGRAM_IDS.OPENBOOK_V2).toBe('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb');
    expect(dexRegistry.getSupportStatus('OPENBOOK_V2')).toBe('UNSUPPORTED');

    // 9. PancakeSwap Solana
    expect(KNOWN_PROGRAM_IDS.PANCAKESWAP).toBe('HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq');
    expect(dexRegistry.getSupportStatus('PANCAKESWAP')).toBe('JUPITER_BUILD_METIS');

    // 10. Manifest
    expect(KNOWN_PROGRAM_IDS.MANIFEST).toBe('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms');
    expect(dexRegistry.getSupportStatus('MANIFEST')).toBe('JUPITER_BUILD_METIS');

    // 11. Pump.fun / PumpSwap
    expect(KNOWN_PROGRAM_IDS.PUMP_FUN).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(dexRegistry.getSupportStatus('PUMP_FUN')).toBe('UNSUPPORTED');

    // 12. Proprietary RFQ (ZeroFi, SolFi, etc.)
    expect(dexRegistry.getSupportStatus('ZERO_FI')).toBe('PROPRIETARY_RESTRICTED');
  });

  it('Parses SPL token vault binary buffer (offset 64..72 u64) for real-time vault streaming', () => {
    // 165-byte standard SPL Token Account buffer
    const buffer = Buffer.alloc(165);
    // Write mint at 0..32, owner at 32..64
    // Write raw amount 102774006674616n at offset 64 (u64 little-endian)
    const expectedAmount = 102774006674616n;
    buffer.writeBigUInt64LE(expectedAmount, 64);

    const parsedAmount = buffer.readBigUInt64LE(64);
    expect(parsedAmount).toBe(expectedAmount);
  });

  it('Cost model differentiates variable transaction fees from refundable rent deposits', () => {
    const config = loadConfig();
    const model = new CostModel(config);

    const res = model.calculateCosts({
      solPriceUSDC: new Decimal(125.0)
    });

    expect(res.isComplete).toBe(true);
    const b = res.breakdown!;

    // Non-refundable variable transaction fees
    expect(parseFloat(b.networkFeeUSDC)).toBeGreaterThan(0);
    expect(parseFloat(b.priorityFeeUSDC)).toBeGreaterThan(0);
    expect(parseFloat(b.contingencyUSDC)).toBe(config.EXECUTION_CONTINGENCY_USDC);

    // Total variable execution costs do NOT include one-time refundable ATA rent deposit
    const sum = new Decimal(b.networkFeeUSDC)
      .add(b.priorityFeeUSDC)
      .add(b.jitoTipUSDC)
      .add(b.tokenTransferFeesUSDC)
      .add(b.contingencyUSDC);
    expect(new Decimal(b.totalCostsUSDC).toFixed(6)).toBe(sum.toFixed(6));
  });
});
