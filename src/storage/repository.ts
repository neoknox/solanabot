import Database from 'better-sqlite3';
import fs from 'fs';
import { ArbitrageCandidate } from '../types/index.js';
import { AppConfig } from '../config/index.js';
import { initDatabase } from './db.js';

export interface StorageStats {
  totalSignals: number;
  qualifiedCount: number;
  candidateCount: number;
  rejectedCount: number;
  totalTheoreticalProfitUSDC: number;
}

export class ArbitrageRepository {
  private db: Database.Database;
  private config: AppConfig;
  private insertCandidateStmt: Database.Statement;
  private insertEventStmt: Database.Statement;

  constructor(config: AppConfig, customDb?: Database.Database) {
    this.config = config;
    this.db = customDb || initDatabase(config);

    this.insertCandidateStmt = this.db.prepare(`
      INSERT OR REPLACE INTO candidates (
        candidate_id, route_name, direction, input_amount_usdc,
        leg1_expected_out_wsol, leg1_conservative_out_wsol,
        leg2_expected_out_usdc, leg2_conservative_out_usdc,
        expected_net_usdc, min_conservative_net_usdc, status,
        rejection_reasons, leg1_pool_id, leg1_dex, leg1_quote_source,
        leg2_pool_id, leg2_dex, leg2_quote_source,
        costs_total_usdc, sol_price_usdc, costs_breakdown_json,
        quote_age_ms, slot_gap, timestamp
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO provider_events (provider, event_type, latency_ms, slot, message, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  public saveCandidate(candidate: ArbitrageCandidate): void {
    // Always store QUALIFIED_SHADOW and CANDIDATE signals; sample 5% of rejected signals
    const isSpecial = candidate.status === 'QUALIFIED_SHADOW' || candidate.status === 'CANDIDATE';
    if (!isSpecial && Math.random() > 0.05) {
      return;
    }

    try {
      this.insertCandidateStmt.run(
        candidate.candidateId,
        candidate.routeName,
        candidate.direction,
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
        JSON.stringify(candidate.costs),
        candidate.quoteAgeMs,
        candidate.slotGap,
        candidate.timestamp
      );
    } catch {
      // Database write error handled gracefully
    }
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

  public purgeOldRecords(retentionHours?: number): number {
    const hours = retentionHours || this.config.DB_RETENTION_HOURS;
    const cutoff = Date.now() - hours * 3600 * 1000;
    const stmt = this.db.prepare('DELETE FROM candidates WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    const eventStmt = this.db.prepare('DELETE FROM provider_events WHERE timestamp < ?');
    eventStmt.run(cutoff);
    return result.changes;
  }

  public getSummaryStats(): StorageStats {
    const counts = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'QUALIFIED_SHADOW' THEN 1 ELSE 0 END) as qualified,
        SUM(CASE WHEN status = 'CANDIDATE' THEN 1 ELSE 0 END) as candidate,
        SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'QUALIFIED_SHADOW' THEN CAST(min_conservative_net_usdc AS REAL) ELSE 0 END) as theoreticalProfit
      FROM candidates
    `).get() as {
      total: number;
      qualified: number;
      candidate: number;
      rejected: number;
      theoreticalProfit: number | null;
    };

    return {
      totalSignals: counts?.total || 0,
      qualifiedCount: counts?.qualified || 0,
      candidateCount: counts?.candidate || 0,
      rejectedCount: counts?.rejected || 0,
      totalTheoreticalProfitUSDC: counts?.theoreticalProfit || 0
    };
  }

  public getTopOpportunities(limit = 10): ArbitrageCandidate[] {
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
      direction: 'USDC_TO_WSOL_TO_USDC',
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
    const rows = this.db.prepare(`
      SELECT 
        candidate_id, route_name, input_amount_usdc,
        expected_net_usdc, min_conservative_net_usdc, status,
        leg1_dex, leg1_pool_id, leg2_dex, leg2_pool_id,
        costs_total_usdc, sol_price_usdc, quote_age_ms, slot_gap,
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

  public close(): void {
    try {
      this.db.close();
    } catch {}
  }
}
