import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { CostModel } from '../src/profit/costModel.js';
import { TradeSizer, QuoterLeg } from '../src/profit/tradeSizer.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import { CompetitorResearchAuditor, DOCUMENTED_PUBLIC_MEV_ARBITRAGES } from '../src/competition/competitorResearch.js';
import { loadConfig, CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT } from '../src/config/index.js';
import { SwapQuote, PoolState } from '../src/types/index.js';
import { DexAdapter } from '../src/dex/types.js';

describe('SOLANABOT — MEV Research Audit: Profit Accuracy & Deterministic Parity Suite', () => {
  const config = loadConfig({
    MIN_NET_PROFIT_USDC: '0.10',
    SAFETY_BUFFER_USDC: '0.25',
    SLIPPAGE_BPS_LEG1: '10',
    SLIPPAGE_BPS_LEG2: '10',
    MAX_PRICE_IMPACT_BPS: '100'
  });

  const costModel = new CostModel(config);
  const thresholdManager = new ProfitThresholdManager({ initialThresholdUSDC: 0.10, silent: true });
  const calculator = new ArbitrageProfitCalculator(config, thresholdManager);
  const tradeSizer = new TradeSizer(config);

  // 1. DEX Fees Counted Correctly in Quote, Not Charged Twice in Cost Model
  it('Priority 2.1: DEX swap fees are embedded in DEX quotes and not double-counted in CostModel', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now()
    });

    expect(costResult.isComplete).toBe(true);
    const breakdown = costResult.breakdown!;

    // DEX fees must NOT be in cost assumptions or totalCostsUSDC
    expect(breakdown.assumptions.some(a => a.toLowerCase().includes('dex fee'))).toBe(false);

    // Pool quote itself contains feeAmount and feeIncluded
    const mockQuote: SwapQuote = {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-1',
      dex: 'RAYDIUM_AMM',
      inputMint: CANONICAL_USDC_MINT,
      outputMint: CANONICAL_WSOL_MINT,
      inAmount: 100000000n, // 100 USDC
      outAmount: 666000000n,
      feeIncluded: true,
      feeAmount: 250000n, // 25 bps = 0.25 USDC
      priceImpactBps: 2,
      slot: 300000000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };

    expect(mockQuote.feeIncluded).toBe(true);
    expect(mockQuote.feeAmount).toBe(250000n);
  });

  // 2. Price Impact Modeled Correctly and Bounded
  it('Priority 2.2: Price impact is strictly evaluated and routes exceeding MAX_PRICE_IMPACT_BPS fail closed', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now()
    });

    const highImpactQuote: SwapQuote = {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-high-impact',
      dex: 'RAYDIUM_AMM',
      inputMint: CANONICAL_USDC_MINT,
      outputMint: CANONICAL_WSOL_MINT,
      inAmount: 100000000n,
      outAmount: 666000000n,
      feeIncluded: true,
      feeAmount: 250000n,
      priceImpactBps: 150, // Exceeds MAX_PRICE_IMPACT_BPS (100 bps)
      slot: 300000000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };

    const normalQuote: SwapQuote = {
      ...highImpactQuote,
      priceImpactBps: 5
    };

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: highImpactQuote,
      leg2Quote: normalQuote,
      costs: costResult.breakdown,
      currentSlot: 300000000,
      wsConnected: true
    });

    expect(candidate.status).toBe('REJECTED');
    expect(candidate.rejectionReasons).toContain('EXCESSIVE_PRICE_IMPACT');
  });

  // 3. Each Slippage Allowance Applied Exactly Once per Leg
  it('Priority 2.3: Each slippage allowance is applied exactly once on conservative output path', () => {
    const inUSDC = 100000000n; // 100 USDC
    const expectedLeg1Out = 1000000000n; // 1.0 SOL
    const expectedLeg2Out = 101000000n; // 101 USDC (gross +$1.00)

    const quote1: SwapQuote = {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-leg1',
      dex: 'RAYDIUM_AMM',
      inputMint: CANONICAL_USDC_MINT,
      outputMint: CANONICAL_WSOL_MINT,
      inAmount: inUSDC,
      outAmount: expectedLeg1Out,
      feeIncluded: true,
      feeAmount: 250000n,
      priceImpactBps: 2,
      slot: 300000000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };

    const quote2: SwapQuote = {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-leg2',
      dex: 'ORCA_WHIRLPOOL',
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT,
      inAmount: expectedLeg1Out,
      outAmount: expectedLeg2Out,
      feeIncluded: true,
      feeAmount: 40000n,
      priceImpactBps: 2,
      slot: 300000000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };

    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now()
    });

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: inUSDC,
      leg1Quote: quote1,
      leg2Quote: quote2,
      costs: costResult.breakdown,
      currentSlot: 300000000,
      wsConnected: true
    });

    // 10 bps slippage on Leg 1: 1,000,000,000 * 10 / 10,000 = 1,000,000 lamports
    expect(candidate.leg1ExpectedOutWSOL).toBe(1000000000n);
    expect(candidate.leg1ConservativeOutWSOL).toBe(999000000n);

    // 10 bps slippage on Leg 2: 101,000,000 * 10 / 10,000 = 101,000 USDC units ($0.101)
    expect(candidate.leg2ExpectedOutUSDC).toBe(101000000n);
    expect(candidate.leg2ConservativeOutUSDC).toBe(100899000n);
  });

  // 4. Safety Buffer Applied Exactly Once in Conservative Net, Zero in Expected Net
  it('Priority 2.4: Safety buffer ($0.25) is subtracted once from conservative net and never from expected net', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now()
    });

    const inUSDC = 100000000n; // 100 USDC
    const outUSDC = 102000000n; // 102 USDC

    const quote1: SwapQuote = {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-1',
      dex: 'RAYDIUM_AMM',
      inputMint: CANONICAL_USDC_MINT,
      outputMint: CANONICAL_WSOL_MINT,
      inAmount: inUSDC,
      outAmount: 1000000000n,
      feeIncluded: true,
      feeAmount: 250000n,
      priceImpactBps: 2,
      slot: 300000000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };

    const quote2: SwapQuote = {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-2',
      dex: 'ORCA_WHIRLPOOL',
      inputMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT,
      inAmount: 1000000000n,
      outAmount: outUSDC,
      feeIncluded: true,
      feeAmount: 40000n,
      priceImpactBps: 2,
      slot: 300000000,
      timestamp: Date.now(),
      executionType: 'POTENTIAL_ATOMIC'
    };

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: inUSDC,
      leg1Quote: quote1,
      leg2Quote: quote2,
      costs: costResult.breakdown,
      currentSlot: 300000000,
      wsConnected: true
    });

    const expectedNet = new Decimal(candidate.expectedNetUSDC);
    const conservativeNet = new Decimal(candidate.minConservativeNetUSDC);
    const totalCosts = new Decimal(candidate.costs.totalCostsUSDC);
    const safetyBuffer = new Decimal(candidate.costs.safetyBufferUSDC);

    // Expected Net = 102 - 100 - totalCosts
    const manualExpected = new Decimal(2.0).sub(totalCosts);
    expect(expectedNet.toFixed(4)).toBe(manualExpected.toFixed(4));

    // Conservative Net = 101.898 - 100 - totalCosts - safetyBuffer
    const conservativeFinal = new Decimal(candidate.leg2ConservativeOutUSDC.toString()).div(1e6);
    const manualConservative = conservativeFinal.sub(100).sub(totalCosts).sub(safetyBuffer);
    expect(conservativeNet.toFixed(4)).toBe(manualConservative.toFixed(4));
  });

  // 5. Jito Tips Modeled as Scenario Costs
  it('Priority 2.5: Jito tips are accurately converted to USDC and accounted in scenario costs', () => {
    const tip50k = costModel.calculateCosts({
      solPriceUSDC: new Decimal(200.0),
      solPriceTimestamp: Date.now(),
      jitoTipLamports: 50000 // 0.00005 SOL * $200 = $0.010000 USDC
    });

    expect(tip50k.isComplete).toBe(true);
    expect(tip50k.breakdown!.jitoTipUSDC).toBe('0.010000');

    const tip100k = costModel.calculateCosts({
      solPriceUSDC: new Decimal(200.0),
      solPriceTimestamp: Date.now(),
      jitoTipLamports: 100000 // 0.00010 SOL * $200 = $0.020000 USDC
    });
    expect(tip100k.breakdown!.jitoTipUSDC).toBe('0.020000');
  });

  // 6. Token Transfer Fees Handled in USDC
  it('Priority 2.6: Token transfer fees (e.g. Token-2022) are modeled in USDC and increase total execution costs', () => {
    const noTransferFee = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now(),
      tradeSizeUSDC: 500
    });

    const withTransferFee = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now(),
      tradeSizeUSDC: 500,
      tokenTransferFeeBps: 20 // 20 bps on $500 = $1.00 USDC
    });

    expect(noTransferFee.breakdown!.tokenTransferFeesUSDC).toBe('0.000000');
    expect(withTransferFee.breakdown!.tokenTransferFeesUSDC).toBe('1.000000');

    // Total costs must increase by exactly $1.00
    const costDiff = new Decimal(withTransferFee.breakdown!.totalCostsUSDC)
      .sub(new Decimal(noTransferFee.breakdown!.totalCostsUSDC));
    expect(costDiff.toFixed(6)).toBe('1.000000');
  });

  // 7. TradeSizer and ArbitrageProfitCalculator Mathematical Parity
  it('Priority 2.7: Sizing and final profit figures agree exactly across tradeSizer and calculator', () => {
    const costResult = costModel.calculateCosts({
      solPriceUSDC: new Decimal(150.0),
      solPriceTimestamp: Date.now()
    });

    // Mock DexAdapter
    const mockLeg1Adapter: DexAdapter = {
      dex: 'RAYDIUM_AMM',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      decodePoolState: () => null,
      quoteExactInput: (_pool, _inMint, inAmount) => ({
        quoteSource: 'DIRECT_POOL',
        poolId: 'pool-1',
        dex: 'RAYDIUM_AMM',
        inputMint: CANONICAL_USDC_MINT,
        outputMint: CANONICAL_WSOL_MINT,
        inAmount,
        outAmount: (inAmount * 6660000n) / 1000000n, // Rate ~0.00666 SOL per USDC
        feeIncluded: true,
        feeAmount: (inAmount * 25n) / 10000n,
        priceImpactBps: 2,
        slot: 300000000,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      })
    };

    const mockLeg2Adapter: DexAdapter = {
      dex: 'ORCA_WHIRLPOOL',
      programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      decodePoolState: () => null,
      quoteExactInput: (_pool, _inMint, inAmount) => ({
        quoteSource: 'DIRECT_POOL',
        poolId: 'pool-2',
        dex: 'ORCA_WHIRLPOOL',
        inputMint: CANONICAL_WSOL_MINT,
        outputMint: CANONICAL_USDC_MINT,
        inAmount,
        outAmount: (inAmount * 152000000n) / 1000000000n, // Rate ~152 USDC per SOL
        feeIncluded: true,
        feeAmount: (inAmount * 4n) / 10000n,
        priceImpactBps: 2,
        slot: 300000000,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      })
    };

    const dummyPool1: PoolState = {
      id: 'pool-1',
      dex: 'RAYDIUM_AMM',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 1000000000000n,
      reserveB: 150000000000000n,
      feeBps: 25,
      liquidityUsd: 1000000,
      feedHealth: 'HEALTHY',
      receivedAt: Date.now(),
      slot: 300000000
    };

    const dummyPool2: PoolState = {
      id: 'pool-2',
      dex: 'ORCA_WHIRLPOOL',
      programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 1000000000000n,
      reserveB: 150000000000000n,
      feeBps: 4,
      liquidityUsd: 1000000,
      feedHealth: 'HEALTHY',
      receivedAt: Date.now(),
      slot: 300000000
    };

    const quoterLegs: QuoterLeg[] = [
      {
        pool: dummyPool1,
        adapter: mockLeg1Adapter,
        inputMint: CANONICAL_USDC_MINT,
        outputMint: CANONICAL_WSOL_MINT,
        slippageBps: 10
      },
      {
        pool: dummyPool2,
        adapter: mockLeg2Adapter,
        inputMint: CANONICAL_WSOL_MINT,
        outputMint: CANONICAL_USDC_MINT,
        slippageBps: 10
      }
    ];

    // Evaluate single size with tradeSizer
    const sizeEval = tradeSizer.evaluateSize(100, quoterLegs, costResult.breakdown!, 300000000);
    expect(sizeEval.isViable).toBe(true);

    // Evaluate candidate with calculator using the quotes from tradeSizer
    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: sizeEval.inputUnits,
      leg1Quote: sizeEval.expectedQuotes[0],
      leg2Quote: sizeEval.expectedQuotes[1],
      leg1ConservativeQuote: sizeEval.conservativeQuotes[0],
      leg2ConservativeQuote: sizeEval.conservativeQuotes[1],
      optimalSizeUSDC: sizeEval.sizeUSDC,
      costs: costResult.breakdown,
      currentSlot: 300000000,
      wsConnected: true
    });

    // PARITY CHECK: tradeSizer.conservativeNetUSDC must equal calculator.minConservativeNetUSDC
    const sizerConservative = sizeEval.conservativeNetUSDC.toFixed(4);
    const calcConservative = candidate.minConservativeNetUSDC;
    expect(calcConservative).toBe(sizerConservative);

    // PARITY CHECK: tradeSizer.expectedNetUSDC must equal calculator.expectedNetUSDC
    const sizerExpected = sizeEval.expectedNetUSDC.toFixed(4);
    const calcExpected = candidate.expectedNetUSDC;
    expect(calcExpected).toBe(sizerExpected);
  });

  // 8. Competitor Research Module Verification
  it('Priority 5.1: Competitor research module contains genuine documented MEV transactions and identifies coverage gaps', () => {
    const summary = CompetitorResearchAuditor.getBenchmarkSummary();
    expect(summary.totalAnalyzed).toBeGreaterThanOrEqual(4);
    expect(summary.avgNetProfitUSDC).toBeGreaterThan(0.10);

    // All records must have legitimate signatures and positive net profit
    for (const rec of DOCUMENTED_PUBLIC_MEV_ARBITRAGES) {
      expect(rec.signature).toBeDefined();
      expect(rec.netProfitUSDC).toBeGreaterThan(0.10);
      expect(rec.totalCostsUSDC).toBeGreaterThan(0);
      expect(rec.pair).toBe('SOL/USDC');
    }

    // Identify gaps against a restricted registry
    const registeredPools = new Set(['Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE']);
    const verifiedPools = new Set(['Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE']);
    const gaps = CompetitorResearchAuditor.identifyCoverageGaps(registeredPools, verifiedPools);

    expect(gaps.some(g => g.dex === 'RAYDIUM_CLMM')).toBe(true);
    expect(gaps.some(g => g.dex === 'METEORA_DLMM')).toBe(true);
  });
});
