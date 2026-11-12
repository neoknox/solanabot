import Database from 'better-sqlite3';
import fs from 'fs';
import { AppConfig } from '../config/index.js';
import { ArbitrageCandidate, AuditMetrics, CompetitorActivityMetrics } from '../types/index.js';
import { initDatabase } from './db.js';

export interface StorageSummaryStats {
  totalSignals: number;
  qualifiedCount: number;
  totalCandidates: number;
  qualifiedShadowCount: number;
  candidateCount: number;
  rejectedCount: number;
  staleCount: number;
  degradedCount: number;
  totalTheoreticalProfitUSDC: number;
  totalProviderEvents: number;
  oldestRecordTimestamp?: number;
  newestRecordTimestamp?: number;
}

export class ArbitrageRepository {
  private config: AppConfig;
  private db: Database.Database;
  private insertCandidateStmt: Database.Statement;
  private insertEventStmt: Database.Statement;
  private batchInsertTransaction: Database.Transaction<(items: ArbitrageCandidate[]) => void>;
  private candidateQueue: ArbitrageCandidate[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, customDb?: Database.Database) {
    this.config = config;
    this.db = customDb || initDatabase(config);

    this.insertCandidateStmt = this.db.prepare(`
      INSERT OR REPLACE INTO candidates (
        candidate_id, route_name, direction, cycle_type, quality_label, optimal_size_usdc,
        input_amount_usdc, leg1_expected_out_wsol, leg1_conservative_out_wsol,
        leg2_expected_out_usdc, leg2_conservative_out_usdc,
        expected_net_usdc, min_conservative_net_usdc, status,
        rejection_reasons, leg1_pool_id, leg1_dex, leg1_quote_source,
        leg2_pool_id, leg2_dex, leg2_quote_source,
        costs_total_usdc, sol_price_usdc, recoverable_deposit_usdc,
        consumed_cost_usdc, potential_loss_failure_usdc, survival_status,
        competition_score, execution_probability, visibility_duration_ms,
        observed_snapshots_count, scoring_breakdown_json,
        costs_breakdown_json, quote_age_ms, slot_gap, timestamp
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO provider_events (provider, event_type, latency_ms, slot, message, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.batchInsertTransaction = this.db.transaction((items: ArbitrageCandidate[]) => {
      for (const candidate of items) {
        this.executeInsertCandidate(candidate);
      }
    });

    // Background flush timer to keep SQLite writes off the quote hot path
    this.flushTimer = setInterval(() => {
      this.flushSync();
    }, 100);
    this.flushTimer.unref();
  }

  private executeInsertCandidate(candidate: ArbitrageCandidate): void {
    try {
      this.insertCandidateStmt.run(
        candidate.candidateId,
        candidate.routeName,
        candidate.direction,
        candidate.cycleType || '2_LEG',
        candidate.qualityLabel || 'INVALID',
        candidate.optimalSizeUSDC || 0,
        candidate.inputAmountUSDC.toString(),
        candidate.leg1ExpectedOutWSOL.toString(),
        candidate.leg1ConservativeOutWSOL.toString(),
        candidate.leg2ExpectedOutUSDC.toString(),
        candidate.leg2ConservativeOutUSDC.toString(),
        candidate.expectedNetUSDC,
        candidate.minConservativeNetUSDC,
        candidate.status,
        JSON.stringify(candidate.rejectionReasons),
        candidate.leg1Quote.poolId,
        candidate.leg1Quote.dex,
        candidate.leg1Quote.quoteSource,
        candidate.leg2Quote.poolId,
        candidate.leg2Quote.dex,
        candidate.leg2Quote.quoteSource,
        candidate.costs.totalCostsUSDC,
        candidate.costs.solPriceUSDC,
        candidate.recoverableDepositUSDC || '0.000000',
        candidate.consumedCostUSDC || candidate.costs.totalCostsUSDC,
        candidate.potentialLossOnFailureUSDC || '0.000000',
        candidate.survivalStatus || 'UNCHECKED',
        candidate.competitionScore || 0,
        candidate.executionProbability || 'UNCALIBRATED',
        candidate.visibilityDurationMs || 0,
        candidate.observedSnapshotsCount || 1,
        JSON.stringify(candidate.scoringBreakdown || {}),
        JSON.stringify(candidate.costs),
        candidate.quoteAgeMs,
        candidate.slotGap,
        candidate.timestamp
      );
    } catch {}
  }

  public saveCandidate(candidate: ArbitrageCandidate): void {
    // Store all QUALIFIED_SHADOW and CANDIDATE signals. Store all rejected if configured, else sample.
    const isSpecial = candidate.status === 'QUALIFIED_SHADOW' || candidate.status === 'CANDIDATE';
    if (!isSpecial && !this.config.LOG_ALL_REJECTED && Math.random() > 0.15) {
      return;
    }

    // Bounded in-memory write buffer for sub-microsecond non-blocking saves
    if (this.candidateQueue.length >= 5000) {
      this.candidateQueue.shift(); // Drop oldest under extreme backpressure
    }
    this.candidateQueue.push(candidate);

    if (this.candidateQueue.length >= 100) {
      this.flushSync();
    }
  }

  public flushSync(): void {
    if (this.candidateQueue.length === 0) return;
    const batch = this.candidateQueue.splice(0, this.candidateQueue.length);
    try {
      this.batchInsertTransaction(batch);
    } catch {}
  }

  public logProviderEvent(
    provider: string,
    eventType: string,
    latencyMs?: number,
    slot?: number,
    message?: string
  ): void {
    try {
      this.insertEventStmt.run(
        provider,
        eventType,
        latencyMs ?? null,
        slot ?? null,
        message ?? null,
        Date.now()
      );
    } catch {}
  }

  public saveCompetitorMetrics(metrics: CompetitorActivityMetrics): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO competitor_metrics (
        pool_id, total_observed_tx, successful_tx_count, failed_tx_count,
        failure_rate, median_fee_lamports, p95_priority_fee, jito_tip_count,
        contention_level, competition_score, sample_window_sec, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        metrics.poolId,
        metrics.totalObservedTx,
        metrics.successfulTxCount,
        metrics.failedTxCount,
        metrics.failureRate,
        metrics.feeDistributionLamports.p50,
        metrics.priorityFeeStatsMicroLamports.p95,
        metrics.jitoTipCount,
        metrics.contentionLevel,
        metrics.historicalCompetitionScore,
        metrics.sampleWindowSeconds,
        Date.now()
      );
    } catch {}
  }

  public getCompetitorMetrics(poolId: string): CompetitorActivityMetrics | null {
    const row = this.db.prepare(`
      SELECT * FROM competitor_metrics WHERE pool_id = ?
    `).get(poolId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      poolId: String(row.pool_id),
      totalObservedTx: Number(row.total_observed_tx),
      successfulTxCount: Number(row.successful_tx_count),
      failedTxCount: Number(row.failed_tx_count),
      failureRate: Number(row.failure_rate),
      feeDistributionLamports: {
        min: 5000,
        p50: Number(row.median_fee_lamports),
        p95: Number(row.median_fee_lamports) * 2,
        max: Number(row.median_fee_lamports) * 3,
        mean: Number(row.median_fee_lamports)
      },
      priorityFeeStatsMicroLamports: {
        min: 0,
        p50: Math.round(Number(row.p95_priority_fee) / 2),
        p95: Number(row.p95_priority_fee),
        max: Number(row.p95_priority_fee) * 2,
        mean: Math.round(Number(row.p95_priority_fee) * 0.6)
      },
      jitoTipCount: Number(row.jito_tip_count),
      jitoTipDistributionLamports: { min: 0, p50: 0, p95: 0, max: 0 },
      contentionLevel: row.contention_level as any,
      historicalCompetitionScore: Number(row.competition_score),
      arbitrageLoopFrequencyPerHour: 0,
      sampleWindowSeconds: Number(row.sample_window_sec),
      lastAnalyzedSlot: 0,
      timestamp: Number(row.timestamp)
    };
  }

  public recordAuditMetrics(metrics: AuditMetrics): void {
    const runId = `AUDIT-${Date.now()}`;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO audit_metrics (
        run_id, total_evaluated, unique_opportunities,
        candidates_gross_positive, candidates_conservative_qualified,
        rejected_routes, quote_validation_failures, unsupported_routes,
        stale_data_rejections, two_leg_evaluated, three_leg_evaluated,
        intra_dex_evaluated, inter_dex_evaluated, competitor_txs_analyzed,
        average_competition_score, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        runId,
        metrics.totalEvaluated,
        metrics.uniqueOpportunities,
        metrics.candidatesGrossPositive,
        metrics.candidatesConservativeQualified,
        metrics.rejectedRoutes,
        metrics.quoteValidationFailures,
        metrics.unsupportedRoutes,
        metrics.staleDataRejections,
        metrics.twoLegEvaluated || 0,
        metrics.threeLegEvaluated || 0,
        metrics.intraDexEvaluated || 0,
        metrics.interDexEvaluated || 0,
        metrics.competitorTxsAnalyzed || 0,
        metrics.averageCompetitionScore || 0,
        Date.now()
      );
    } catch {}
  }

  public getLatestAuditMetrics(): AuditMetrics | null {
    const row = this.db.prepare(`
      SELECT * FROM audit_metrics ORDER BY timestamp DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      totalEvaluated: Number(row.total_evaluated),
      uniqueOpportunities: Number(row.unique_opportunities),
      candidatesGrossPositive: Number(row.candidates_gross_positive),
      candidatesConservativeQualified: Number(row.candidates_conservative_qualified),
      rejectedRoutes: Number(row.rejected_routes),
      quoteValidationFailures: Number(row.quote_validation_failures),
      unsupportedRoutes: Number(row.unsupported_routes),
      staleDataRejections: Number(row.stale_data_rejections),
      twoLegEvaluated: Number(row.two_leg_evaluated || 0),
      threeLegEvaluated: Number(row.three_leg_evaluated || 0),
      intraDexEvaluated: Number(row.intra_dex_evaluated || 0),
      interDexEvaluated: Number(row.inter_dex_evaluated || 0),
      competitorTxsAnalyzed: Number(row.competitor_txs_analyzed || 0),
      averageCompetitionScore: Number(row.average_competition_score || 0)
    };
  }

  public getSummaryStats(): StorageSummaryStats {
    this.flushSync();
    const candidateCounts = this.db.prepare(`
      SELECT 
        status, 
        COUNT(*) as count 
      FROM candidates 
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    let qualifiedShadowCount = 0;
    let candidateCount = 0;
    let rejectedCount = 0;
    let staleCount = 0;
    let degradedCount = 0;
    let totalCandidates = 0;

    for (const row of candidateCounts) {
      totalCandidates += row.count;
      switch (row.status) {
        case 'QUALIFIED_SHADOW': qualifiedShadowCount = row.count; break;
        case 'CANDIDATE': candidateCount = row.count; break;
        case 'REJECTED': rejectedCount = row.count; break;
        case 'STALE': staleCount = row.count; break;
        case 'DEGRADED': degradedCount = row.count; break;
      }
    }

    const eventCountRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM provider_events
    `).get() as { count: number };

    const timeExtremes = this.db.prepare(`
      SELECT 
        MIN(timestamp) as oldest, 
        MAX(timestamp) as newest 
      FROM candidates
    `).get() as { oldest: number | null; newest: number | null };

    const profitRow = this.db.prepare(`
      SELECT SUM(CAST(min_conservative_net_usdc AS REAL)) as totalProfit
      FROM candidates
      WHERE status = 'QUALIFIED_SHADOW'
    `).get() as { totalProfit: number | null };

    const totalTheoreticalProfitUSDC = Number(profitRow?.totalProfit || 0);

    return {
      totalSignals: totalCandidates,
      qualifiedCount: qualifiedShadowCount,
      totalCandidates,
      qualifiedShadowCount,
      candidateCount,
      rejectedCount,
      staleCount,
      degradedCount,
      totalTheoreticalProfitUSDC,
      totalProviderEvents: eventCountRow?.count || 0,
      oldestRecordTimestamp: timeExtremes?.oldest ?? undefined,
      newestRecordTimestamp: timeExtremes?.newest ?? undefined
    };
  }

  public getTopOpportunities(limit = 10): ArbitrageCandidate[] {
    this.flushSync();
    const rows = this.db.prepare(`
      SELECT * FROM candidates 
      ORDER BY 
        CASE WHEN status = 'QUALIFIED_SHADOW' THEN 0 ELSE 1 END,
        CAST(min_conservative_net_usdc AS REAL) DESC 
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      candidateId: String(r.candidate_id),
      routeName: String(r.route_name),
      direction: String(r.direction || 'USDC_TO_WSOL_TO_USDC'),
      cycleType: (r.cycle_type as any) || '2_LEG',
      qualityLabel: (r.quality_label as any) || 'INVALID',
      optimalSizeUSDC: Number(r.optimal_size_usdc || 0),
      recoverableDepositUSDC: String(r.recoverable_deposit_usdc || '0'),
      consumedCostUSDC: String(r.consumed_cost_usdc || '0'),
      potentialLossOnFailureUSDC: String(r.potential_loss_failure_usdc || '0'),
      survivalStatus: (r.survival_status as any) || 'UNCHECKED',
      competitionScore: Number(r.competition_score || 0),
      executionProbability: (r.execution_probability as any) || 'UNCALIBRATED',
      visibilityDurationMs: Number(r.visibility_duration_ms || 0),
      observedSnapshotsCount: Number(r.observed_snapshots_count || 1),
      scoringBreakdown: JSON.parse(String(r.scoring_breakdown_json || '{}')),
      inputAmountUSDC: BigInt(String(r.input_amount_usdc)),
      leg1ExpectedOutWSOL: BigInt(String(r.leg1_expected_out_wsol)),
      leg1ConservativeOutWSOL: BigInt(String(r.leg1_conservative_out_wsol)),
      leg2ExpectedOutUSDC: BigInt(String(r.leg2_expected_out_usdc)),
      leg2ConservativeOutUSDC: BigInt(String(r.leg2_conservative_out_usdc)),
      expectedNetUSDC: String(r.expected_net_usdc),
      minConservativeNetUSDC: String(r.min_conservative_net_usdc),
      status: r.status as ArbitrageCandidate['status'],
      rejectionReasons: JSON.parse(String(r.rejection_reasons)),
      leg1Quote: {
        quoteSource: r.leg1_quote_source as any,
        poolId: String(r.leg1_pool_id),
        dex: r.leg1_dex as any,
        inputMint: '',
        outputMint: '',
        inAmount: 0n,
        outAmount: BigInt(String(r.leg1_expected_out_wsol)),
        feeIncluded: true,
        feeAmount: 0n,
        priceImpactBps: 0,
        slot: 0,
        timestamp: Number(r.timestamp),
        executionType: 'POTENTIAL_ATOMIC'
      },
      leg2Quote: {
        quoteSource: r.leg2_quote_source as any,
        poolId: String(r.leg2_pool_id),
        dex: r.leg2_dex as any,
        inputMint: '',
        outputMint: '',
        inAmount: 0n,
        outAmount: BigInt(String(r.leg2_expected_out_usdc)),
        feeIncluded: true,
        feeAmount: 0n,
        priceImpactBps: 0,
        slot: 0,
        timestamp: Number(r.timestamp),
        executionType: 'POTENTIAL_ATOMIC'
      },
      costs: JSON.parse(String(r.costs_breakdown_json)),
      timestamp: Number(r.timestamp),
      slotGap: Number(r.slot_gap),
      quoteAgeMs: Number(r.quote_age_ms)
    }));
  }

  public exportToCsv(filePath: string): number {
    this.flushSync();
    const rows = this.db.prepare(`
      SELECT 
        candidate_id, route_name, cycle_type, quality_label, optimal_size_usdc,
        input_amount_usdc, expected_net_usdc, min_conservative_net_usdc, status,
        competition_score, execution_probability, visibility_duration_ms,
        leg1_dex, leg1_pool_id, leg2_dex, leg2_pool_id,
        costs_total_usdc, sol_price_usdc, potential_loss_failure_usdc,
        quote_age_ms, slot_gap,
        datetime(timestamp / 1000, 'unixepoch') as time_utc
      FROM candidates
      ORDER BY timestamp DESC
    `).all() as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      fs.writeFileSync(filePath, 'No candidate records to export\n');
      return 0;
    }

    const headers = Object.keys(rows[0]).join(',');
    const csvLines = [headers];

    for (const row of rows) {
      const line = Object.values(row)
        .map(v => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`))
        .join(',');
      csvLines.push(line);
    }

    fs.writeFileSync(filePath, csvLines.join('\n'));
    return rows.length;
  }

  public purgeOldRecords(hoursToKeep: number): number {
    this.flushSync();
    const cutoffTimestamp = Date.now() - (hoursToKeep * 60 * 60 * 1000);
    const result = this.db.prepare(`
      DELETE FROM candidates WHERE timestamp < ?
    `).run(cutoffTimestamp);
    return result.changes;
  }

  public close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
    try {
      this.db.close();
    } catch {}
  }
}
