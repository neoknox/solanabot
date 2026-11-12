import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { CostModel } from '../src/profit/costModel.js';
import { loadConfig, CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT } from '../src/config/index.js';
import { SwapQuote, CostBreakdown } from '../src/types/index.js';

describe('Phase 1.2 Acceptance: Cost Engine, Downside Accounting & Quality Labels', () => {
  const config = loadConfig();
  const calculator = new ArbitrageProfitCalculator(config);
  const costModel = new CostModel(config);

  const createDummyQuote = (params: Partial<SwapQuote>): SwapQuote => ({
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool-1',
    dex: 'RAYDIUM_AMM',
    inputMint: CANONICAL_USDC_MINT,
    outputMint: CANONICAL_WSOL_MINT,
    inAmount: 100000000n, // $100 USDC
    outAmount: 606060606n, // ~ 0.606 SOL
    feeIncluded: true,
    feeAmount: 250000n,
    priceImpactBps: 5,
    slot: 2000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC',
    ...params
  });

  it('Matrix 1.2-E: CostModel distinguishes recoverable ATA deposit from permanently consumed costs', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(165.0),
      solPriceTimestamp: Date.now(),
      requiresAtaSetup: true
    });

    expect(costResult.isComplete).toBe(true);
    expect(costResult.breakdown).not.toBeNull();

    const bd = costResult.breakdown!;
    expect(parseFloat(bd.recoverableDepositUSDC || '0')).toBeGreaterThan(0.30); // ~ 0.00203928 SOL * $165 ~= $0.336
    expect(parseFloat(bd.consumedCostUSDC || '0')).toBeLessThan(0.05);          // Sigs + priority fee ~= $0.02

    // Total execution cost accounts only for consumed costs, as ATA rent is returned
    expect(parseFloat(bd.totalCostsUSDC)).toBeCloseTo(parseFloat(bd.consumedCostUSDC || '0'), 3);

    // Potential loss on failure equals base signature fee + priority compute fee
    expect(parseFloat(bd.potentialLossOnFailureUSDC || '0')).toBeGreaterThan(0);
    expect(parseFloat(bd.potentialLossOnFailureUSDC || '0')).toBeLessThan(parseFloat(bd.totalCostsUSDC));
  });

  it('Matrix 1.2-F: Exact $0.50 Profit Boundary Hurdle Enforcement', () => {
    const quote1 = createDummyQuote({
      poolId: 'pool-A',
      inputMint: CANONICAL_USDC_MINT,
      outputMint: CANONICAL_WSOL_MINT,
      outAmount: 606060606n
    });

    // Test Case 1: Exactly $0.4999 conservative net (fails hurdle)
    // Target conservative out = 100 + 0.021875 (costs) + 0.25 (buffer) + 0.4999 = 100.771775 USDC
    // With 10 bps slippage, outAmount = 100.771775 / 0.999 = 100.872647 USDC -> 100872647n
    const quote2Fail = createDummyQuote({
      poolId: 'pool-B',
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT,
      outAmount: 100872647n
    });

    const costBreakdown: CostBreakdown = {
      networkFeeUSDC: '0.000625',
      priorityFeeUSDC: '0.001250',
      jitoTipUSDC: '0.000000',
      tokenTransferFeesUSDC: '0.000000',
      contingencyUSDC: '0.0200',
      safetyBufferUSDC: '0.2500',
      totalCostsUSDC: '0.021875',
      solPriceUSDC: '165.00',
      recoverableDepositUSDC: '0.336481',
      consumedCostUSDC: '0.021875',
      potentialLossOnFailureUSDC: '0.001875',
      assumptions: []
    };

    const candidateFail = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote2Fail,
      costs: costBreakdown,
      currentSlot: 2000,
      wsConnected: true
    });

    expect(candidateFail.status).toBe('CANDIDATE');
    expect(candidateFail.qualityLabel).toBe('INVALID');
    expect(candidateFail.rejectionReasons).toContain('LOW_CONSERVATIVE_NET');

    // Test Case 2: Exactly $0.5001 conservative net (passes hurdle)
    // Target conservative out = 100 + 0.021875 + 0.25 + 0.5001 = 100.771975 USDC
    // With 10 bps slippage, outAmount = 100.771975 / 0.999 = 100.872847 USDC -> 100873000n
    const quote2Pass = createDummyQuote({
      poolId: 'pool-B',
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT,
      outAmount: 100873000n
    });

    const candidatePass = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote2Pass,
      costs: costBreakdown,
      currentSlot: 2000,
      wsConnected: true
    });

    expect(candidatePass.status).toBe('QUALIFIED_SHADOW');
    expect(candidatePass.qualityLabel).toBe('SHADOW_QUALIFIED');
    expect(candidatePass.rejectionReasons.length).toBe(0);
    expect(parseFloat(candidatePass.minConservativeNetUSDC)).toBeGreaterThanOrEqual(0.50);
  });

  it('Matrix 1.2-G: Opportunity Quality Labels: INVALID, INDICATIVE_ONLY, SHADOW_QUALIFIED', () => {
    const quote1 = createDummyQuote({ poolId: 'pool-A' });

    // 1. Unverified concentrated liquidity quote -> INDICATIVE_ONLY
    const unverifiedQuote = createDummyQuote({
      poolId: 'pool-B',
      isUnverified: true
    } as any);

    const costBreakdown: CostBreakdown = {
      networkFeeUSDC: '0.000625',
      priorityFeeUSDC: '0.001250',
      jitoTipUSDC: '0.000000',
      tokenTransferFeesUSDC: '0.000000',
      contingencyUSDC: '0.0200',
      safetyBufferUSDC: '0.2500',
      totalCostsUSDC: '0.021875',
      solPriceUSDC: '165.00',
      assumptions: []
    };

    const indicativeCandidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: unverifiedQuote,
      costs: costBreakdown,
      currentSlot: 2000,
      wsConnected: true
    });

    expect(indicativeCandidate.qualityLabel).toBe('INDICATIVE_ONLY');
    expect(indicativeCandidate.status).toBe('UNSUPPORTED');

    // 2. Disconnected WebSocket or Stale Quote -> INVALID
    const disconnectedCandidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote1,
      costs: costBreakdown,
      currentSlot: 2000,
      wsConnected: false
    });

    expect(disconnectedCandidate.qualityLabel).toBe('INVALID');

    // Verify prohibition: NEVER emit ATOMIC_READY or LIVE_PROFIT in Phase 1.2
    expect((indicativeCandidate as any).qualityLabel).not.toBe('ATOMIC_READY');
    expect((indicativeCandidate as any).qualityLabel).not.toBe('LIVE_PROFIT');
    expect((disconnectedCandidate as any).qualityLabel).not.toBe('ATOMIC_READY');
  });

  it('Matrix 1.2-H: Fee Spikes and Huge Tips immediately reject candidate', () => {
    const quote1 = createDummyQuote({ poolId: 'pool-A', outAmount: 606060606n });
    const quote2 = createDummyQuote({ poolId: 'pool-B', outAmount: 101000000n }); // +$1 gross

    // Simulate extreme network fee spike (e.g. $1.50 priority fee / Jito tip)
    const spikedCosts: CostBreakdown = {
      networkFeeUSDC: '0.000625',
      priorityFeeUSDC: '1.500000',
      jitoTipUSDC: '1.000000',
      tokenTransferFeesUSDC: '0.000000',
      contingencyUSDC: '0.0200',
      safetyBufferUSDC: '0.2500',
      totalCostsUSDC: '2.520625',
      solPriceUSDC: '165.00',
      assumptions: ['Fee spike simulation']
    };

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: quote1,
      leg2Quote: quote2,
      costs: spikedCosts,
      currentSlot: 2000,
      wsConnected: true
    });

    expect(candidate.status).toBe('REJECTED');
    expect(candidate.rejectionReasons).toContain('LOW_CONSERVATIVE_NET');
    expect(candidate.qualityLabel).toBe('INVALID');
  });
});
