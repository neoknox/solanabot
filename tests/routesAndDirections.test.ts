import { describe, it, expect } from 'vitest';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { StateCache } from '../src/scanner/stateCache.js';
import { loadConfig } from '../src/config/index.js';
import { SwapQuote, CostBreakdown } from '../src/types/index.js';

describe('Test Matrix 3, 4, 14: Trading Directions, Duplicate Routes, and Deduplication', () => {
  const config = loadConfig();
  const calculator = new ArbitrageProfitCalculator(config);
  const cache = new StateCache();

  const dummyCosts: CostBreakdown = {
    networkFeeUSDC: '0.000625',
    priorityFeeUSDC: '0.001250',
    jitoTipUSDC: '0.000000',
    tokenTransferFeesUSDC: '0.000000',
    contingencyUSDC: '0.0200',
    safetyBufferUSDC: '0.2500',
    totalCostsUSDC: '0.021875',
    solPriceUSDC: '125.00',
    assumptions: ['Standard test assumptions']
  };

  const createQuote = (params: Partial<SwapQuote>): SwapQuote => ({
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool-A-111',
    dex: 'RAYDIUM_AMM',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmount: 100000000n, // 100 USDC
    outAmount: 800000000n, // 0.80 SOL
    feeIncluded: true,
    feeAmount: 250000n,
    priceImpactBps: 5,
    slot: 468500000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC',
    ...params
  });

  it('Matrix 3.1: Supports both directions (USDC -> WSOL and WSOL -> USDC)', () => {
    const quote1 = createQuote({
      poolId: 'pool-A',
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: 100000000n,
      outAmount: 810000000n
    });

    const quote2 = createQuote({
      poolId: 'pool-B',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: 809190000n,
      outAmount: 102000000n // $102 USDC (net profitable)
    });

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote2,
      costs: dummyCosts,
      currentSlot: 468500000,
      wsConnected: true
    });

    expect(candidate.direction).toBe('USDC_TO_WSOL_TO_USDC');
    expect(candidate.status).toBe('QUALIFIED_SHADOW');
  });

  it('Matrix 3.2: Supports same-DEX different-pool routes (e.g. Orca Pool 1 vs Orca Pool 2)', () => {
    const quote1 = createQuote({
      poolId: 'orca-pool-fee-004',
      dex: 'ORCA_WHIRLPOOL',
      outAmount: 810000000n
    });
    const quote2 = createQuote({
      poolId: 'orca-pool-fee-020',
      dex: 'ORCA_WHIRLPOOL',
      outAmount: 102000000n
    });

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote2,
      costs: dummyCosts,
      currentSlot: 468500000,
      wsConnected: true
    });

    expect(candidate.rejectionReasons).not.toContain('REUSED_IDENTICAL_POOL');
    expect(candidate.status).toBe('QUALIFIED_SHADOW');
  });

  it('Matrix 4.1: Rejects identical pool used on both legs', () => {
    const identicalPoolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
    const quote1 = createQuote({ poolId: identicalPoolId });
    const quote2 = createQuote({ poolId: identicalPoolId });

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote2,
      costs: dummyCosts,
      currentSlot: 468500000,
      wsConnected: true
    });

    expect(candidate.status).toBe('REJECTED');
    expect(candidate.rejectionReasons).toContain('REUSED_IDENTICAL_POOL');
  });

  it('Matrix 14.1: Deduplicates identical repeated opportunities while permitting updated states', () => {
    const key = {
      route: 'poolA->poolB',
      amountUSDC: 100000000n,
      netProfitUSDC: '0.8500'
    };

    // First appearance: not duplicate
    expect(cache.isDuplicate(key)).toBe(false);

    // Immediate second appearance: duplicate!
    expect(cache.isDuplicate(key)).toBe(true);

    // Changed net profit (due to pool state change): not duplicate!
    const updatedKey = {
      ...key,
      netProfitUSDC: '0.9200'
    };
    expect(cache.isDuplicate(updatedKey)).toBe(false);
  });
});
