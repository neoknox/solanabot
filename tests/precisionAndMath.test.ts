import { describe, it, expect } from 'vitest';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { PoolState } from '../src/types/index.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';

describe('Test Matrix 2, 8, 15: BigInt Precision, Multi-Stage Sizing, and Liquidity Scaling', () => {
  const adapter = new RaydiumAmmAdapter();

  const mockPool: PoolState = {
    id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    dex: 'RAYDIUM_AMM',
    programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
    tokenAMint: CANONICAL_WSOL_MINT,
    tokenBMint: CANONICAL_USDC_MINT,
    tokenADecimals: 9,
    tokenBDecimals: 6,
    reserveA: 100000n * 1000000000n, // 100,000 SOL
    reserveB: 12500000n * 1000000n,  // 12,500,000 USDC ($125/SOL)
    feeBps: 25,
    slot: 468500000,
    receivedAt: Date.now(),
    liquidityUsd: 25000000,
    feedHealth: 'HEALTHY'
  };

  it('Matrix 2.1: Handles tiny micro amounts without underflow or floating point distortion', () => {
    const tinyUSDC = 1000n; // 0.001 USDC
    const quote = adapter.quoteExactInput(mockPool, CANONICAL_USDC_MINT, tinyUSDC);

    expect(quote).not.toBeNull();
    expect(typeof quote!.outAmount).toBe('bigint');
    expect(quote!.outAmount).toBeGreaterThan(0n);
    // Integer rounding should ensure fee is non-negative and properly deducted
    expect(quote!.feeAmount).toBeGreaterThanOrEqual(0n);
  });

  it('Matrix 2.2: Handles large capital amounts exceeding JS Number.MAX_SAFE_INTEGER in base units', () => {
    // 50,000,000 SOL in lamports = 5 * 10^16 > 9 * 10^15 (MAX_SAFE_INTEGER)
    const largeLamports = 50000000000000000n;
    const deepPool: PoolState = {
      ...mockPool,
      reserveA: 100000000n * 1000000000n,
      reserveB: 12500000000n * 1000000n
    };

    const quote = adapter.quoteExactInput(deepPool, CANONICAL_WSOL_MINT, largeLamports);
    expect(quote).not.toBeNull();
    expect(quote!.outAmount).toBeGreaterThan(0n);
  });

  it('Matrix 8.1: Applies exact floor rounding on conservative leg slippage deduction', () => {
    const rawOutWSOL = 800054321n;
    const slippageBps = 10n; // 0.10%
    const slippageDeduction = (rawOutWSOL * slippageBps) / 10000n;
    const conservativeWSOL = rawOutWSOL - slippageDeduction;

    expect(slippageDeduction).toBe(800054n);
    expect(conservativeWSOL).toBe(799254267n);
    expect(conservativeWSOL).toBeLessThan(rawOutWSOL);
  });

  it('Matrix 15.1: Verifies that larger trade sizes experience higher price impact and lower marginal output', () => {
    const quoteSmall = adapter.quoteExactInput(mockPool, CANONICAL_USDC_MINT, 100n * 1000000n); // $100
    const quoteLarge = adapter.quoteExactInput(mockPool, CANONICAL_USDC_MINT, 1000000n * 1000000n); // $1,000,000

    expect(quoteSmall).not.toBeNull();
    expect(quoteLarge).not.toBeNull();

    // Price impact for large trade must exceed small trade
    expect(quoteLarge!.priceImpactBps).toBeGreaterThan(quoteSmall!.priceImpactBps);

    // Effective price (out/in) should be worse for larger trade due to constant-product curve
    const smallRate = (Number(quoteSmall!.outAmount) * 1e6) / Number(quoteSmall!.inAmount);
    const largeRate = (Number(quoteLarge!.outAmount) * 1e6) / Number(quoteLarge!.inAmount);
    expect(largeRate).toBeLessThan(smallRate);
  });
});
