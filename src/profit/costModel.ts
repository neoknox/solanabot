import Decimal from 'decimal.js';
import { AppConfig } from '../config/index.js';
import { CostBreakdown } from '../types/index.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

export interface FeeEstimateInput {
  solPriceUSDC?: Decimal;
  solPriceTimestamp?: number;
  measuredPriorityFeeLamports?: number;
  tokenTransferFeeBps?: number;
  requiresAtaSetup?: boolean;
}

export class CostModel {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  public calculateCosts(input: FeeEstimateInput): {
    breakdown: CostBreakdown | null;
    isComplete: boolean;
    missingReason?: string;
  } {
    // Validate SOL/USDC price for converting lamport fees
    if (!input.solPriceUSDC || input.solPriceUSDC.lte(0)) {
      return {
        breakdown: null,
        isComplete: false,
        missingReason: 'Missing or invalid SOL/USDC price for fee conversion'
      };
    }

    const now = Date.now();
    if (input.solPriceTimestamp && (now - input.solPriceTimestamp) > this.config.MAX_QUOTE_AGE_MS * 2) {
      return {
        breakdown: null,
        isComplete: false,
        missingReason: 'SOL price conversion quote is stale'
      };
    }

    const solPrice = input.solPriceUSDC;
    const assumptions: string[] = [];

    // 1. Network base signature fee (default 5,000 lamports per sig)
    const totalBaseFeeLamports = new Decimal(this.config.NETWORK_FEE_LAMPORTS_PER_SIGNATURE)
      .mul(this.config.ESTIMATED_SIGNATURES);
    const networkFeeUSDC = totalBaseFeeLamports.div(1e9).mul(solPrice);
    assumptions.push(
      `Network base fee: ${this.config.ESTIMATED_SIGNATURES} sig(s) @ ${this.config.NETWORK_FEE_LAMPORTS_PER_SIGNATURE} lamports = $${networkFeeUSDC.toFixed(6)}`
    );

    // 2. Priority compute fee
    const priorityLamports = new Decimal(
      input.measuredPriorityFeeLamports ?? this.config.PRIORITY_FEE_LAMPORTS
    );
    const priorityFeeUSDC = priorityLamports.div(1e9).mul(solPrice);
    assumptions.push(
      `Priority fee: ${priorityLamports.toString()} lamports = $${priorityFeeUSDC.toFixed(6)}`
    );

    // 3. Jito validator tip
    const jitoLamports = new Decimal(this.config.JITO_TIP_LAMPORTS);
    const jitoTipUSDC = jitoLamports.div(1e9).mul(solPrice);
    assumptions.push(
      `Jito tip: ${jitoLamports.toString()} lamports = $${jitoTipUSDC.toFixed(6)} (Default 0 for read-only)`
    );

    // 4. Token transfer fees (0 for canonical SPL, non-zero for Token-2022 if applicable)
    const tokenTransferFeesUSDC = new Decimal(0);
    if (input.tokenTransferFeeBps && input.tokenTransferFeeBps > 0) {
      assumptions.push(`Token transfer fee: ${input.tokenTransferFeeBps} bps`);
    }

    // 5. Execution contingency
    const contingencyUSDC = new Decimal(this.config.EXECUTION_CONTINGENCY_USDC);
    assumptions.push(`Execution contingency: $${contingencyUSDC.toFixed(4)}`);

    // 6. Safety buffer hurdle
    const safetyBufferUSDC = new Decimal(this.config.SAFETY_BUFFER_USDC);
    assumptions.push(`Safety buffer hurdle: $${safetyBufferUSDC.toFixed(4)}`);

    // 7. Recoverable ATA deposit (if temporary WSOL ATA creation/close is needed)
    let recoverableDepositUSDC = new Decimal(0);
    if (input.requiresAtaSetup) {
      const ataRentLamports = new Decimal(this.config.ATA_RENT_EXEMPT_LAMPORTS || 2039280);
      recoverableDepositUSDC = ataRentLamports.div(1e9).mul(solPrice);
      assumptions.push(`Recoverable ATA rent deposit: $${recoverableDepositUSDC.toFixed(4)} (returned upon ATA close)`);
    }

    // Permanently consumed costs: base signature fee + priority compute fee + Jito tip + token transfer fees + contingency
    const consumedCostUSDC = networkFeeUSDC
      .add(priorityFeeUSDC)
      .add(jitoTipUSDC)
      .add(tokenTransferFeesUSDC)
      .add(contingencyUSDC);

    // Total execution costs (consumed costs only, as rent deposit is fully refunded in atomic tx)
    const totalCostsUSDC = consumedCostUSDC;

    // Potential loss on failure: If transaction reverts on-chain due to min-profit slippage check,
    // principal capital and ATA rent are preserved by runtime rollback.
    // Permanently burned: base network fee + priority fee.
    const potentialLossOnFailureUSDC = networkFeeUSDC.add(priorityFeeUSDC);

    return {
      breakdown: {
        networkFeeUSDC: networkFeeUSDC.toFixed(6),
        priorityFeeUSDC: priorityFeeUSDC.toFixed(6),
        jitoTipUSDC: jitoTipUSDC.toFixed(6),
        tokenTransferFeesUSDC: tokenTransferFeesUSDC.toFixed(6),
        contingencyUSDC: contingencyUSDC.toFixed(4),
        safetyBufferUSDC: safetyBufferUSDC.toFixed(4),
        totalCostsUSDC: totalCostsUSDC.toFixed(6),
        solPriceUSDC: solPrice.toFixed(4),
        recoverableDepositUSDC: recoverableDepositUSDC.toFixed(6),
        consumedCostUSDC: consumedCostUSDC.toFixed(6),
        potentialLossOnFailureUSDC: potentialLossOnFailureUSDC.toFixed(6),
        assumptions
      },
      isComplete: true
    };
  }
}
