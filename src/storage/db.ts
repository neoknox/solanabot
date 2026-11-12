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
      costs_breakdown_json TEXT NOT NULL,
      quote_age_ms INTEGER NOT NULL,
      slot_gap INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
    CREATE INDEX IF NOT EXISTS idx_candidates_timestamp ON candidates(timestamp);

    CREATE TABLE IF NOT EXISTS provider_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      latency_ms INTEGER,
      slot INTEGER,
      message TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON provider_events(timestamp);
  `);

  return db;
}
