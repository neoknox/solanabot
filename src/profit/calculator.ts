import Decimal from 'decimal.js';
import { AppConfig } from '../config/index.js';
import {
  SwapQuote,
  ArbitrageCandidate,
  OpportunityStatus,
  RejectionReasonCode,
  CostBreakdown
} from '../types/index.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

export class ArbitrageProfitCalculator {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  public evaluateCandidate(params: {
    initialAmountUSDC: bigint;
    leg1Quote: SwapQuote;
    leg2Quote: SwapQuote;
    costs: CostBreakdown | null;
    currentSlot: number;
    wsConnected: boolean;
    solPriceTimestamp?: number;
  }): ArbitrageCandidate {
    const {
      initialAmountUSDC,
      leg1Quote,
      leg2Quote,
      costs,
      currentSlot,
      wsConnected,
      solPriceTimestamp
    } = params;

    const candidateId = `ARB-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const routeName = `${leg1Quote.dex} -> ${leg2Quote.dex} (${leg1Quote.quoteSource} / ${leg2Quote.quoteSource})`;
    const rejectionReasons: RejectionReasonCode[] = [];

    const now = Date.now();
    const quoteAgeMs = Math.max(
      now - leg1Quote.timestamp,
      now - leg2Quote.timestamp
    );
    const slotGap = Math.abs(leg1Quote.slot - leg2Quote.slot);

    // 1. Connection check
    if (!wsConnected) {
      rejectionReasons.push('WS_DISCONNECTED');
    }

    // 2. Freshness and Slot synchronization
    if (quoteAgeMs > this.config.MAX_QUOTE_AGE_MS) {
      rejectionReasons.push('STALE_QUOTE');
    }
    if (slotGap > this.config.MAX_SLOT_GAP) {
      rejectionReasons.push('SLOT_MISMATCH');
    }

    // 3. Pool duplication check (same pool cannot be both legs of an arbitrage)
    if (leg1Quote.poolId && leg2Quote.poolId && leg1Quote.poolId === leg2Quote.poolId) {
      rejectionReasons.push('REUSED_IDENTICAL_POOL');
    }

    // 4. Quote validity check
    if (leg1Quote.outAmount <= 0n || leg2Quote.outAmount <= 0n) {
      rejectionReasons.push('INSUFFICIENT_LIQUIDITY');
    }

    // 4b. Composable Route & Verification checks
    if (
      leg1Quote.executionType === 'INDICATIVE_ONLY' ||
      leg2Quote.executionType === 'INDICATIVE_ONLY'
    ) {
      rejectionReasons.push('UNSUPPORTED_ROUTE');
    }

    if (
      (leg1Quote as any).isUnverified ||
      (leg2Quote as any).isUnverified
    ) {
      rejectionReasons.push('QUOTE_UNVERIFIED');
    }

    // 5. Price impact bounds
    if (
      leg1Quote.priceImpactBps > this.config.MAX_PRICE_IMPACT_BPS ||
      leg2Quote.priceImpactBps > this.config.MAX_PRICE_IMPACT_BPS
    ) {
      rejectionReasons.push('EXCESSIVE_PRICE_IMPACT');
    }

    // 6. Two-stage conservative leg sizing (BigInt floor rounding)
    const leg1ExpectedOutWSOL = leg1Quote.outAmount;
    const slippageBps1 = BigInt(this.config.SLIPPAGE_BPS_LEG1);
    const slippage1 = (leg1ExpectedOutWSOL * slippageBps1) / 10000n;
    const leg1ConservativeOutWSOL = leg1ExpectedOutWSOL - slippage1;

    const leg2ExpectedOutUSDC = leg2Quote.outAmount;
    const slippageBps2 = BigInt(this.config.SLIPPAGE_BPS_LEG2);
    const slippage2 = (leg2ExpectedOutUSDC * slippageBps2) / 10000n;
    const leg2ConservativeOutUSDC = leg2ExpectedOutUSDC - slippage2;

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
      assumptions: ['Missing cost model']
    };

    // Financial calculations via Decimal.js (safe 30-digit decimal arithmetic)
    const initialDecimal = new Decimal(initialAmountUSDC.toString()).div(1e6);
    const leg2ExpectedDecimal = new Decimal(leg2ExpectedOutUSDC.toString()).div(1e6);
    const leg2ConservativeDecimal = new Decimal(leg2ConservativeOutUSDC.toString()).div(1e6);
    const totalCostsDecimal = new Decimal(defaultCosts.totalCostsUSDC);
    const safetyBufferDecimal = new Decimal(defaultCosts.safetyBufferUSDC);

    // Expected Quote Net: leg2Expected - initial - totalCosts
    const expectedNetUSDC = leg2ExpectedDecimal
      .sub(initialDecimal)
      .sub(totalCostsDecimal);

    // Conservative Net: leg2Conservative - initial - totalCosts - safetyBuffer
    const minConservativeNetUSDC = leg2ConservativeDecimal
      .sub(initialDecimal)
      .sub(totalCostsDecimal)
      .sub(safetyBufferDecimal);

    // Max execution cost check
    if (totalCostsDecimal.gt(this.config.MAX_EXECUTION_COST_USDC)) {
      rejectionReasons.push('LOW_CONSERVATIVE_NET');
    }

    // Target minimum profit check: >= MIN_NET_PROFIT_USDC ($0.50)
    const minProfitHurdle = new Decimal(this.config.MIN_NET_PROFIT_USDC);
    if (minConservativeNetUSDC.lt(minProfitHurdle)) {
      if (!rejectionReasons.includes('LOW_CONSERVATIVE_NET')) {
        rejectionReasons.push('LOW_CONSERVATIVE_NET');
      }
    }

    // Determine status
    let status: OpportunityStatus = 'REJECTED';
    if (rejectionReasons.length === 0) {
      status = 'QUALIFIED_SHADOW';
    } else if (rejectionReasons.includes('STALE_QUOTE') || rejectionReasons.includes('PRICE_CONVERSION_STALE')) {
      status = 'STALE';
    } else if (rejectionReasons.includes('WS_DISCONNECTED')) {
      status = 'DEGRADED';
    } else if (expectedNetUSDC.gt(0) && rejectionReasons.length === 1 && rejectionReasons[0] === 'LOW_CONSERVATIVE_NET') {
      status = 'CANDIDATE';
    } else {
      status = 'REJECTED';
    }

    return {
      candidateId,
      routeName,
      leg1Quote,
      leg2Quote,
      direction: 'USDC_TO_WSOL_TO_USDC',
      inputAmountUSDC: initialAmountUSDC,
      leg1ExpectedOutWSOL,
      leg1ConservativeOutWSOL,
      leg2ExpectedOutUSDC,
      leg2ConservativeOutUSDC,
      costs: defaultCosts,
      expectedNetUSDC: expectedNetUSDC.toFixed(4),
      minConservativeNetUSDC: minConservativeNetUSDC.toFixed(4),
      status,
      rejectionReasons,
      timestamp: now,
      slotGap,
      quoteAgeMs
    };
  }
}
