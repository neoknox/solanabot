import Decimal from 'decimal.js';
import { AppConfig, CANONICAL_USDC_MINT } from '../config/index.js';
import {
  SwapQuote,
  ArbitrageCandidate,
  OpportunityStatus,
  OpportunityQualityLabel,
  CycleType,
  TradeSizingMethod,
  RejectionReasonCode,
  CostBreakdown
} from '../types/index.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

export interface CandidateEvaluationParams {
  initialAmountUSDC: bigint;
  leg1Quote: SwapQuote;
  leg2Quote: SwapQuote;
  leg3Quote?: SwapQuote;
  cycleType?: CycleType;
  optimalSizeUSDC?: number;
  sizingMethod?: TradeSizingMethod;
  costs: CostBreakdown | null;
  currentSlot: number;
  wsConnected: boolean;
  solPriceTimestamp?: number;
}

export class ArbitrageProfitCalculator {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  public evaluateCandidate(params: CandidateEvaluationParams): ArbitrageCandidate {
    const {
      initialAmountUSDC,
      leg1Quote,
      leg2Quote,
      leg3Quote,
      cycleType = leg3Quote ? '3_LEG' : '2_LEG',
      optimalSizeUSDC,
      sizingMethod,
      costs,
      currentSlot,
      wsConnected,
      solPriceTimestamp
    } = params;

    const candidateId = `ARB-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const routeName = leg3Quote
      ? `${leg1Quote.dex} -> ${leg2Quote.dex} -> ${leg3Quote.dex} (3-Leg Cycle)`
      : `${leg1Quote.dex} -> ${leg2Quote.dex} (${leg1Quote.quoteSource} / ${leg2Quote.quoteSource})`;

    const rejectionReasons: RejectionReasonCode[] = [];
    const now = Date.now();

    // 1. Connection check
    if (!wsConnected) {
      rejectionReasons.push('WS_DISCONNECTED');
    }

    // 2. Freshness and Slot synchronization
    const quotes = leg3Quote ? [leg1Quote, leg2Quote, leg3Quote] : [leg1Quote, leg2Quote];
    const quoteAgeMs = Math.max(...quotes.map(q => now - q.timestamp));
    const slots = quotes.map(q => q.slot);
    const slotGap = Math.max(...slots) - Math.min(...slots);

    if (quoteAgeMs > this.config.MAX_QUOTE_AGE_MS) {
      rejectionReasons.push('STALE_QUOTE');
    }
    if (slotGap > this.config.MAX_SLOT_GAP) {
      rejectionReasons.push('SLOT_MISMATCH');
    }

    // 3. Pool duplication check (same pool cannot be repeated in identical route)
    const poolIds = quotes.map(q => q.poolId).filter(Boolean);
    const uniquePoolIds = new Set(poolIds);
    if (uniquePoolIds.size < poolIds.length) {
      rejectionReasons.push('REUSED_IDENTICAL_POOL');
    }

    // 4. Quote validity check
    for (const q of quotes) {
      if (q.outAmount <= 0n) {
        if (!rejectionReasons.includes('INSUFFICIENT_LIQUIDITY')) {
          rejectionReasons.push('INSUFFICIENT_LIQUIDITY');
        }
      }
      if (q.executionType === 'INDICATIVE_ONLY') {
        if (!rejectionReasons.includes('UNSUPPORTED_ROUTE')) {
          rejectionReasons.push('UNSUPPORTED_ROUTE');
        }
      }
      if ((q as any).isUnverified) {
        if (!rejectionReasons.includes('QUOTE_UNVERIFIED')) {
          rejectionReasons.push('QUOTE_UNVERIFIED');
        }
      }
      if (q.priceImpactBps > this.config.MAX_PRICE_IMPACT_BPS) {
        if (!rejectionReasons.includes('EXCESSIVE_PRICE_IMPACT')) {
          rejectionReasons.push('EXCESSIVE_PRICE_IMPACT');
        }
      }
    }

    // 5. Mint continuity checks (must start and end in USDC)
    if (leg3Quote) {
      if (leg1Quote.inputMint !== CANONICAL_USDC_MINT || leg3Quote.outputMint !== CANONICAL_USDC_MINT) {
        rejectionReasons.push('INVALID_MINT');
      }
      if (leg1Quote.outputMint !== leg2Quote.inputMint || leg2Quote.outputMint !== leg3Quote.inputMint) {
        rejectionReasons.push('INVALID_MINT');
      }
    } else {
      if (leg1Quote.inputMint && leg1Quote.inputMint !== CANONICAL_USDC_MINT && leg1Quote.inputMint !== 'mock-usdc') {
        rejectionReasons.push('INVALID_MINT');
      }
      if (leg2Quote.outputMint === CANONICAL_USDC_MINT && leg1Quote.outputMint && leg2Quote.inputMint) {
        if (leg1Quote.outputMint !== leg2Quote.inputMint) {
          rejectionReasons.push('INVALID_MINT');
        }
      }
    }

    // 6. Multi-stage conservative leg sizing (BigInt floor rounding)
    const leg1ExpectedOutWSOL = leg1Quote.outAmount;
    const slippageBps1 = BigInt(this.config.SLIPPAGE_BPS_LEG1);
    const slippage1 = (leg1ExpectedOutWSOL * slippageBps1) / 10000n;
    const leg1ConservativeOutWSOL = leg1ExpectedOutWSOL - slippage1;

    const leg2ExpectedOutUSDC = leg2Quote.outAmount;
    const slippageBps2 = BigInt(this.config.SLIPPAGE_BPS_LEG2);
    const slippage2 = (leg2ExpectedOutUSDC * slippageBps2) / 10000n;
    const leg2ConservativeOutUSDC = leg2ExpectedOutUSDC - slippage2;

    let leg3ExpectedOutUSDC: bigint | undefined;
    let leg3ConservativeOutUSDC: bigint | undefined;

    let finalExpectedUnits: bigint;
    let finalConservativeUnits: bigint;

    if (leg3Quote) {
      leg3ExpectedOutUSDC = leg3Quote.outAmount;
      const slippageBps3 = BigInt(this.config.SLIPPAGE_BPS_LEG3 || 10);
      const slippage3 = (leg3ExpectedOutUSDC * slippageBps3) / 10000n;
      leg3ConservativeOutUSDC = leg3ExpectedOutUSDC - slippage3;

      finalExpectedUnits = leg3ExpectedOutUSDC;
      finalConservativeUnits = leg3ConservativeOutUSDC;
    } else {
      finalExpectedUnits = leg2ExpectedOutUSDC;
      finalConservativeUnits = leg2ConservativeOutUSDC;
    }

    // 7. Cost breakdown verification
    if (!costs) {
      rejectionReasons.push('MISSING_COST_ESTIMATE');
    }
    if (solPriceTimestamp && (now - solPriceTimestamp) > this.config.MAX_QUOTE_AGE_MS * 2) {
      rejectionReasons.push('PRICE_CONVERSION_STALE');
    }

    const defaultCosts: CostBreakdown = costs || {
      networkFeeUSDC: '0.000000',
      priorityFeeUSDC: '0.000000',
      jitoTipUSDC: '0.000000',
      tokenTransferFeesUSDC: '0.000000',
      contingencyUSDC: this.config.EXECUTION_CONTINGENCY_USDC.toString(),
      safetyBufferUSDC: this.config.SAFETY_BUFFER_USDC.toString(),
      totalCostsUSDC: '999.000000',
      solPriceUSDC: '0.00',
      recoverableDepositUSDC: '0.000000',
      consumedCostUSDC: '999.000000',
      potentialLossOnFailureUSDC: '0.000000',
      assumptions: ['Missing cost model']
    };

    // Financial calculations via Decimal.js (safe 30-digit decimal arithmetic)
    const initialDecimal = new Decimal(initialAmountUSDC.toString()).div(1e6);
    const finalExpectedDecimal = new Decimal(finalExpectedUnits.toString()).div(1e6);
    const finalConservativeDecimal = new Decimal(finalConservativeUnits.toString()).div(1e6);
    const totalCostsDecimal = new Decimal(defaultCosts.totalCostsUSDC);
    const safetyBufferDecimal = new Decimal(defaultCosts.safetyBufferUSDC);

    // Expected Quote Net: finalExpected - initial - totalCosts
    const expectedNetUSDC = finalExpectedDecimal
      .sub(initialDecimal)
      .sub(totalCostsDecimal);

    // Conservative Net: finalConservative - initial - totalCosts - safetyBuffer
    const minConservativeNetUSDC = finalConservativeDecimal
      .sub(initialDecimal)
      .sub(totalCostsDecimal)
      .sub(safetyBufferDecimal);

    // Max execution cost check
    if (totalCostsDecimal.gt(this.config.MAX_EXECUTION_COST_USDC)) {
      if (!rejectionReasons.includes('LOW_CONSERVATIVE_NET')) {
        rejectionReasons.push('LOW_CONSERVATIVE_NET');
      }
    }

    // Target minimum profit check: >= MIN_NET_PROFIT_USDC ($0.50)
    const minProfitHurdle = new Decimal(this.config.MIN_NET_PROFIT_USDC);
    if (minConservativeNetUSDC.lt(minProfitHurdle)) {
      if (!rejectionReasons.includes('LOW_CONSERVATIVE_NET')) {
        rejectionReasons.push('LOW_CONSERVATIVE_NET');
      }
    }

    // Determine status & quality label
    let status: OpportunityStatus = 'REJECTED';
    let qualityLabel: OpportunityQualityLabel = 'INVALID';

    if (rejectionReasons.length === 0) {
      status = 'QUALIFIED_SHADOW';
      qualityLabel = 'SHADOW_QUALIFIED';
    } else if (rejectionReasons.includes('STALE_QUOTE') || rejectionReasons.includes('PRICE_CONVERSION_STALE')) {
      status = 'STALE';
      qualityLabel = 'INVALID';
    } else if (rejectionReasons.includes('WS_DISCONNECTED')) {
      status = 'DEGRADED';
      qualityLabel = 'INVALID';
    } else if (rejectionReasons.includes('QUOTE_UNVERIFIED') || rejectionReasons.includes('MISSING_TICK_DATA') || rejectionReasons.includes('UNSUPPORTED_ROUTE')) {
      status = 'UNSUPPORTED';
      qualityLabel = 'INDICATIVE_ONLY';
    } else if (expectedNetUSDC.gt(0) && rejectionReasons.length === 1 && rejectionReasons[0] === 'LOW_CONSERVATIVE_NET') {
      status = 'CANDIDATE';
      qualityLabel = 'INVALID';
    } else {
      status = 'REJECTED';
      qualityLabel = 'INVALID';
    }

    const potentialLossUSDC = defaultCosts.potentialLossOnFailureUSDC || '0.000000';
    let riskRewardRatio = '0.00';
    if (minConservativeNetUSDC.gt(0)) {
      riskRewardRatio = new Decimal(potentialLossUSDC).div(minConservativeNetUSDC).toFixed(2);
    }

    const direction = leg3Quote
      ? `USDC_TO_${leg1Quote.outputMint.slice(0, 4)}_TO_${leg2Quote.outputMint.slice(0, 4)}_TO_USDC`
      : 'USDC_TO_WSOL_TO_USDC';

    return {
      candidateId,
      routeName,
      direction,
      cycleType,
      qualityLabel,
      optimalSizeUSDC,
      sizingMethod,
      inputAmountUSDC: initialAmountUSDC,
      leg1Quote,
      leg1ExpectedOutWSOL,
      leg1ConservativeOutWSOL,
      leg2Quote,
      leg2ExpectedOutUSDC,
      leg2ConservativeOutUSDC,
      leg3Quote,
      leg3ExpectedOutUSDC,
      leg3ConservativeOutUSDC,
      costs: {
        ...defaultCosts,
        riskRewardRatio
      },
      recoverableDepositUSDC: defaultCosts.recoverableDepositUSDC,
      consumedCostUSDC: defaultCosts.consumedCostUSDC,
      potentialLossOnFailureUSDC: potentialLossUSDC,
      expectedNetUSDC: expectedNetUSDC.toFixed(4),
      minConservativeNetUSDC: minConservativeNetUSDC.toFixed(4),
      status,
      rejectionReasons,
      timestamp: now,
      slotGap,
      quoteAgeMs,
      survivalStatus: 'UNCHECKED'
    };
  }
}
