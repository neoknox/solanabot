import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AppConfig } from '../config/index.js';

export function initDatabase(config: AppConfig): Database.Database {
  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      candidate_id TEXT PRIMARY KEY,
      route_name TEXT NOT NULL,
      direction TEXT NOT NULL,
      cycle_type TEXT DEFAULT '2_LEG',
      quality_label TEXT DEFAULT 'INVALID',
      optimal_size_usdc REAL DEFAULT 0,
      input_amount_usdc TEXT NOT NULL,
      leg1_expected_out_wsol TEXT NOT NULL,
      leg1_conservative_out_wsol TEXT NOT NULL,
      leg2_expected_out_usdc TEXT NOT NULL,
      leg2_conservative_out_usdc TEXT NOT NULL,
      expected_net_usdc TEXT NOT NULL,
      min_conservative_net_usdc TEXT NOT NULL,
      status TEXT NOT NULL,
      rejection_reasons TEXT NOT NULL,
      leg1_pool_id TEXT NOT NULL,
      leg1_dex TEXT NOT NULL,
      leg1_quote_source TEXT NOT NULL,
      leg2_pool_id TEXT NOT NULL,
      leg2_dex TEXT NOT NULL,
      leg2_quote_source TEXT NOT NULL,
      costs_total_usdc TEXT NOT NULL,
      sol_price_usdc TEXT NOT NULL,
      recoverable_deposit_usdc TEXT DEFAULT '0',
      consumed_cost_usdc TEXT DEFAULT '0',
      potential_loss_failure_usdc TEXT DEFAULT '0',
      survival_status TEXT DEFAULT 'UNCHECKED',
      competition_score REAL DEFAULT 0,
      execution_probability TEXT DEFAULT 'UNCALIBRATED',
      visibility_duration_ms INTEGER DEFAULT 0,
      observed_snapshots_count INTEGER DEFAULT 1,
      scoring_breakdown_json TEXT DEFAULT '{}',
      costs_breakdown_json TEXT NOT NULL,
      quote_age_ms INTEGER NOT NULL,
      slot_gap INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      latency_ms INTEGER,
      slot INTEGER,
      message TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS competitor_metrics (
      pool_id TEXT PRIMARY KEY,
      total_observed_tx INTEGER NOT NULL,
      successful_tx_count INTEGER NOT NULL,
      failed_tx_count INTEGER NOT NULL,
      failure_rate REAL NOT NULL,
      median_fee_lamports INTEGER NOT NULL,
      p95_priority_fee INTEGER NOT NULL,
      jito_tip_count INTEGER NOT NULL,
      contention_level TEXT NOT NULL,
      competition_score INTEGER NOT NULL,
      sample_window_sec INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_metrics (
      run_id TEXT PRIMARY KEY,
      total_evaluated INTEGER NOT NULL,
      unique_opportunities INTEGER NOT NULL,
      candidates_gross_positive INTEGER NOT NULL,
      candidates_conservative_qualified INTEGER NOT NULL,
      rejected_routes INTEGER NOT NULL,
      quote_validation_failures INTEGER NOT NULL,
      unsupported_routes INTEGER NOT NULL,
      stale_data_rejections INTEGER NOT NULL,
      two_leg_evaluated INTEGER DEFAULT 0,
      three_leg_evaluated INTEGER DEFAULT 0,
      intra_dex_evaluated INTEGER DEFAULT 0,
      inter_dex_evaluated INTEGER DEFAULT 0,
      competitor_txs_analyzed INTEGER DEFAULT 0,
      average_competition_score REAL DEFAULT 0,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      route_id TEXT PRIMARY KEY,
      cycle_type TEXT NOT NULL,
      is_intra_dex INTEGER NOT NULL,
      ordered_pool_ids TEXT NOT NULL,
      ordered_dex_programs TEXT NOT NULL,
      ordered_tokens TEXT NOT NULL,
      static_dependencies_json TEXT NOT NULL,
      dynamic_dependencies_json TEXT NOT NULL,
      protocol_adapter_version TEXT NOT NULL,
      estimated_accounts INTEGER NOT NULL,
      estimated_compute_units INTEGER NOT NULL,
      state TEXT NOT NULL,
      is_unprofitable_preserved INTEGER NOT NULL DEFAULT 1,
      last_quote_expected_net_usdc TEXT,
      last_quote_timestamp INTEGER,
      verification_details TEXT,
      last_verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verified_pools (
      pool_id TEXT PRIMARY KEY,
      dex TEXT NOT NULL,
      program_id TEXT NOT NULL,
      token_a_mint TEXT NOT NULL,
      token_b_mint TEXT NOT NULL,
      fee_bps INTEGER NOT NULL,
      verification_status TEXT NOT NULL,
      blocker_reason TEXT,
      initial_liquidity_usd REAL DEFAULT 0,
      account_layout_size INTEGER DEFAULT 0,
      last_verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Safe incremental column migration if table already existed from earlier phases
  const candidateColumns = db.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>;
  const colNames = new Set(candidateColumns.map(c => c.name));
  if (!colNames.has('cycle_type')) db.exec("ALTER TABLE candidates ADD COLUMN cycle_type TEXT DEFAULT '2_LEG'");
  if (!colNames.has('quality_label')) db.exec("ALTER TABLE candidates ADD COLUMN quality_label TEXT DEFAULT 'INVALID'");
  if (!colNames.has('optimal_size_usdc')) db.exec("ALTER TABLE candidates ADD COLUMN optimal_size_usdc REAL DEFAULT 0");
  if (!colNames.has('recoverable_deposit_usdc')) db.exec("ALTER TABLE candidates ADD COLUMN recoverable_deposit_usdc TEXT DEFAULT '0'");
  if (!colNames.has('consumed_cost_usdc')) db.exec("ALTER TABLE candidates ADD COLUMN consumed_cost_usdc TEXT DEFAULT '0'");
  if (!colNames.has('potential_loss_failure_usdc')) db.exec("ALTER TABLE candidates ADD COLUMN potential_loss_failure_usdc TEXT DEFAULT '0'");
  if (!colNames.has('survival_status')) db.exec("ALTER TABLE candidates ADD COLUMN survival_status TEXT DEFAULT 'UNCHECKED'");
  if (!colNames.has('competition_score')) db.exec("ALTER TABLE candidates ADD COLUMN competition_score REAL DEFAULT 0");
  if (!colNames.has('execution_probability')) db.exec("ALTER TABLE candidates ADD COLUMN execution_probability TEXT DEFAULT 'UNCALIBRATED'");
  if (!colNames.has('visibility_duration_ms')) db.exec("ALTER TABLE candidates ADD COLUMN visibility_duration_ms INTEGER DEFAULT 0");
  if (!colNames.has('observed_snapshots_count')) db.exec("ALTER TABLE candidates ADD COLUMN observed_snapshots_count INTEGER DEFAULT 1");
  if (!colNames.has('scoring_breakdown_json')) db.exec("ALTER TABLE candidates ADD COLUMN scoring_breakdown_json TEXT DEFAULT '{}'");

  const auditColumns = db.prepare("PRAGMA table_info(audit_metrics)").all() as Array<{ name: string }>;
  const auditColNames = new Set(auditColumns.map(c => c.name));
  if (!auditColNames.has('two_leg_evaluated')) db.exec("ALTER TABLE audit_metrics ADD COLUMN two_leg_evaluated INTEGER DEFAULT 0");
  if (!auditColNames.has('three_leg_evaluated')) db.exec("ALTER TABLE audit_metrics ADD COLUMN three_leg_evaluated INTEGER DEFAULT 0");
  if (!auditColNames.has('intra_dex_evaluated')) db.exec("ALTER TABLE audit_metrics ADD COLUMN intra_dex_evaluated INTEGER DEFAULT 0");
  if (!auditColNames.has('inter_dex_evaluated')) db.exec("ALTER TABLE audit_metrics ADD COLUMN inter_dex_evaluated INTEGER DEFAULT 0");
  if (!auditColNames.has('competitor_txs_analyzed')) db.exec("ALTER TABLE audit_metrics ADD COLUMN competitor_txs_analyzed INTEGER DEFAULT 0");
  if (!auditColNames.has('average_competition_score')) db.exec("ALTER TABLE audit_metrics ADD COLUMN average_competition_score REAL DEFAULT 0");

  // Create indexes after ensuring columns exist
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
    CREATE INDEX IF NOT EXISTS idx_candidates_timestamp ON candidates(timestamp);
    CREATE INDEX IF NOT EXISTS idx_candidates_quality ON candidates(quality_label);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON provider_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_routes_state ON routes(state);
    CREATE INDEX IF NOT EXISTS idx_routes_cycle_type ON routes(cycle_type);
    CREATE INDEX IF NOT EXISTS idx_routes_updated_at ON routes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_verified_pools_dex ON verified_pools(dex);
    CREATE INDEX IF NOT EXISTS idx_verified_pools_status ON verified_pools(verification_status);
  `);

  return db;
}
