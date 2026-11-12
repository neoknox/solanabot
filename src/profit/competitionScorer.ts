import {
  ArbitrageCandidate,
  CompetitorActivityMetrics,
  ScoringBreakdown,
  ExecutionProbability
} from '../types/index.js';

export class CompetitionScorer {
  /**
   * Scores an arbitrage opportunity based on net profit, capital efficiency,
   * quote freshness, historical competition, and route complexity.
   * Deterministic, explainable, and zero ML fabrication.
   */
  public scoreCandidate(
    candidate: ArbitrageCandidate,
    poolMetricsList: CompetitorActivityMetrics[]
  ): {
    score: number;
    breakdown: ScoringBreakdown;
    executionProbability: ExecutionProbability;
  } {
    const rationale: string[] = [];

    // 1. Profitability Score (0 to 35 pts)
    const netProfit = parseFloat(candidate.minConservativeNetUSDC);
    let profitabilityScore = 0;
    if (netProfit > 0) {
      profitabilityScore = Math.min(35, Math.round((netProfit / 0.50) * 10));
      rationale.push(`Profitability: $${netProfit.toFixed(4)} conservative net = ${profitabilityScore}/35 pts`);
    } else {
      rationale.push(`Profitability: non-positive net profit ($${netProfit.toFixed(4)}) = 0/35 pts`);
    }

    // 2. Capital Efficiency Score (0 to 20 pts)
    const inputSizeUSDC = candidate.optimalSizeUSDC || Number(candidate.inputAmountUSDC) / 1e6;
    let capitalEfficiencyScore = 0;
    if (netProfit > 0 && inputSizeUSDC > 0) {
      const returnPct = (netProfit / inputSizeUSDC) * 100;
      capitalEfficiencyScore = Math.min(20, Math.round(returnPct * 10));
      rationale.push(`Capital efficiency: ${returnPct.toFixed(2)}% net return on $${inputSizeUSDC.toFixed(0)} = ${capitalEfficiencyScore}/20 pts`);
    } else {
      rationale.push(`Capital efficiency: 0% return = 0/20 pts`);
    }

    // 3. Quote Freshness & Slot Lag Score (0 to 15 pts)
    let quoteFreshnessScore = 15;
    const agePenalty = Math.floor(candidate.quoteAgeMs / 250);
    const slotPenalty = candidate.slotGap * 2;
    quoteFreshnessScore = Math.max(0, quoteFreshnessScore - agePenalty - slotPenalty);
    rationale.push(`Quote freshness: age ${candidate.quoteAgeMs}ms (-${agePenalty}), slot gap ${candidate.slotGap} (-${slotPenalty}) = ${quoteFreshnessScore}/15 pts`);

    // 4. Competition & Pool Contention Factor (0 to 20 pts awarded)
    // Lower pool competition score gives higher awarded score
    let avgPoolCompetition = 25; // default moderate
    if (poolMetricsList.length > 0) {
      const sumComp = poolMetricsList.reduce((acc, m) => acc + m.historicalCompetitionScore, 0);
      avgPoolCompetition = Math.round(sumComp / poolMetricsList.length);
    }
    const competitionPenalty = Math.max(0, Math.min(20, Math.round(20 - (avgPoolCompetition * 0.20))));
    rationale.push(`Competition: average pool competition score ${avgPoolCompetition}/100 = ${competitionPenalty}/20 pts awarded`);

    // 5. Route Complexity Score (0 to 10 pts)
    let complexityScore = 8;
    if (candidate.cycleType === '3_LEG') {
      complexityScore = 5;
      rationale.push(`Route complexity: 3-leg triangular cycle (3 pool hops) = 5/10 pts`);
    } else if (candidate.routeName.includes('Intra-DEX') || candidate.leg1Quote.dex === candidate.leg2Quote.dex) {
      complexityScore = 10;
      rationale.push(`Route complexity: intra-DEX single protocol (lowest cross-program overhead) = 10/10 pts`);
    } else {
      complexityScore = 8;
      rationale.push(`Route complexity: standard 2-leg cross-DEX cycle = 8/10 pts`);
    }

    const totalScore = Math.min(
      100,
      Math.max(0, profitabilityScore + capitalEfficiencyScore + quoteFreshnessScore + competitionPenalty + complexityScore)
    );

    // As mandated by Section 4: Before live transaction outcomes exist, label execution probability UNCALIBRATED.
    const executionProbability: ExecutionProbability = 'UNCALIBRATED';

    const breakdown: ScoringBreakdown = {
      profitabilityScore,
      capitalEfficiencyScore,
      quoteFreshnessScore,
      competitionPenalty,
      complexityScore,
      totalScore,
      rationale
    };

    return {
      score: totalScore,
      breakdown,
      executionProbability
    };
  }
}
