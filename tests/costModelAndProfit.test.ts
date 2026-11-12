import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { CostModel } from '../src/profit/costModel.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { loadConfig } from '../src/config/index.js';
import { SwapQuote } from '../src/types/index.js';

describe('Test Matrix 5, 6, 7, 9: Cost Modeling, Deductions, and $0.50 Net Profit Boundary', () => {
  const config = loadConfig({
    MIN_NET_PROFIT_USDC: '0.50',
    SAFETY_BUFFER_USDC: '0.25'
  });
  const costModel = new CostModel(config);
  const calculator = new ArbitrageProfitCalculator(config);

  const baseQuote = (outUSDC: bigint): SwapQuote => ({
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool-leg2',
    dex: 'ORCA_WHIRLPOOL',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: 800000000n,
    outAmount: outUSDC,
    feeIncluded: true,
    feeAmount: 32000n,
    priceImpactBps: 2,
    slot: 468500000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC'
  });

  const leg1Quote: SwapQuote = {
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool-leg1',
    dex: 'RAYDIUM_AMM',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmount: 100000000n, // $100 USDC input
    outAmount: 800000000n,
    feeIncluded: true,
    feeAmount: 250000n,
    priceImpactBps: 3,
    slot: 468500000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC'
  };

  it('Matrix 5.1: Verifies pool fee & price impact are already deducted in quote and not charged twice in cost model', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(125.0),
      solPriceTimestamp: Date.now()
    });
    expect(costResult.isComplete).toBe(true);
    // Cost model only accounts for network, compute priority, jito tips, contingency, buffer.
    // Pool swap fees are already part of the DEX quote output amount.
    expect(costResult.breakdown?.assumptions.some(a => a.includes('DEX fee'))).toBe(false);
  });

  it('Matrix 6.1: Cost model accounts for network base fee, priority fee, jito tip, contingency, and safety buffer', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(125.0),
      solPriceTimestamp: Date.now(),
      measuredPriorityFeeLamports: 15000
    });

    expect(costResult.isComplete).toBe(true);
    const b = costResult.breakdown!;
    expect(parseFloat(b.networkFeeUSDC)).toBeGreaterThan(0);
    expect(parseFloat(b.priorityFeeUSDC)).toBeGreaterThan(0);
    expect(parseFloat(b.contingencyUSDC)).toBe(config.EXECUTION_CONTINGENCY_USDC);
    expect(parseFloat(b.safetyBufferUSDC)).toBe(config.SAFETY_BUFFER_USDC);
    expect(parseFloat(b.totalCostsUSDC)).toBeGreaterThan(0);
  });

  it('Matrix 7.1: Missing or stale price conversion blocks qualification', () => {
    // Missing SOL price
    const missingPrice = costModel.calculateCosts({
      solPriceUSDC: undefined,
      solPriceTimestamp: Date.now()
    });
    expect(missingPrice.isComplete).toBe(false);
    expect(missingPrice.breakdown).toBeNull();

    // Missing timestamp (fails closed)
    const missingTimestamp = costModel.calculateCosts({
      solPriceUSDC: new Decimal(125.0)
    });
    expect(missingTimestamp.isComplete).toBe(false);
    expect(missingTimestamp.missingReason).toContain('Missing or zero SOL price timestamp');

    // Zero timestamp (fails closed)
    const zeroTimestamp = costModel.calculateCosts({
      solPriceUSDC: new Decimal(125.0),
      solPriceTimestamp: 0
    });
    expect(zeroTimestamp.isComplete).toBe(false);

    // Future timestamp (fails closed)
    const futureTimestamp = costModel.calculateCosts({
      solPriceUSDC: new Decimal(125.0),
      solPriceTimestamp: Date.now() + 60000
    });
    expect(futureTimestamp.isComplete).toBe(false);
    expect(futureTimestamp.missingReason).toContain('future');

    // Stale SOL price
    const stalePrice = costModel.calculateCosts({
      solPriceUSDC: new Decimal(125.0),
      solPriceTimestamp: Date.now() - 60000 // 60s old > MAX_QUOTE_AGE_MS * 2
    });
    expect(stalePrice.isComplete).toBe(false);

    // Calculator must reject candidate with missing costs
    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote,
      leg2Quote: baseQuote(102000000n),
      costs: null,
      currentSlot: 468500000,
      wsConnected: true
    });
    expect(candidate.status).toBe('REJECTED');
    expect(candidate.rejectionReasons).toContain('MISSING_COST_ESTIMATE');
  });

  it('Matrix 9.1: Exact threshold test: $0.49 net rejected, $0.50 accepted, $0.51 accepted', () => {
    const costs = costModel.calculateCosts({ solPriceUSDC: new Decimal(125.0), solPriceTimestamp: Date.now() }).breakdown!;
    const totalCosts = new Decimal(costs.totalCostsUSDC);
    const buffer = new Decimal(costs.safetyBufferUSDC);

    const calcNeededOut = (targetNet: number): bigint => {
      const conservativeNeeded = new Decimal(100).add(totalCosts).add(buffer).add(targetNet);
      const rawNeeded = conservativeNeeded.div(0.999).mul(1e6);
      return BigInt(Math.ceil(rawNeeded.toNumber()));
    };

    // Test $0.49 net -> MUST BE REJECTED (LOW_CONSERVATIVE_NET)
    const outFor49 = calcNeededOut(0.49);
    const cand49 = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote,
      leg2Quote: baseQuote(outFor49),
      costs,
      currentSlot: 468500000,
      wsConnected: true
    });
    expect(parseFloat(cand49.minConservativeNetUSDC)).toBeLessThan(0.50);
    expect(cand49.status).toBe('CANDIDATE'); // Expected net is positive, but below $0.50 hurdle
    expect(cand49.rejectionReasons).toContain('LOW_CONSERVATIVE_NET');

    // Test $0.50 net -> MUST QUALIFY (QUALIFIED_SHADOW)
    const outFor50 = calcNeededOut(0.50);
    const cand50 = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote,
      leg2Quote: baseQuote(outFor50),
      costs,
      currentSlot: 468500000,
      wsConnected: true
    });
    expect(parseFloat(cand50.minConservativeNetUSDC)).toBeGreaterThanOrEqual(0.50);
    expect(cand50.status).toBe('QUALIFIED_SHADOW');
    expect(cand50.rejectionReasons).toHaveLength(0);

    // Test $0.51 net -> MUST QUALIFY (QUALIFIED_SHADOW)
    const outFor51 = calcNeededOut(0.51);
    const cand51 = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote,
      leg2Quote: baseQuote(outFor51),
      costs,
      currentSlot: 468500000,
      wsConnected: true
    });
    expect(parseFloat(cand51.minConservativeNetUSDC)).toBeGreaterThanOrEqual(0.50);
    expect(cand51.status).toBe('QUALIFIED_SHADOW');
    expect(cand51.rejectionReasons).toHaveLength(0);
  });
});
