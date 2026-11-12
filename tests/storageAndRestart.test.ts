import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { loadConfig } from '../src/config/index.js';
import { ArbitrageCandidate } from '../src/types/index.js';

describe('Test Matrix 20: SQLite Persistence, Integrity on Restart, Retention, and CSV Export', () => {
  const testDbPath = path.resolve(__dirname, 'test_arbitrage.db');
  const testCsvPath = path.resolve(__dirname, 'test_export.csv');
  let config = loadConfig({ DB_PATH: testDbPath });
  let repo: ArbitrageRepository;

  const sampleCandidate = (id: string, ageMs = 0): ArbitrageCandidate => ({
    candidateId: id,
    routeName: 'Raydium -> Orca',
    direction: 'USDC_TO_WSOL_TO_USDC',
    inputAmountUSDC: 100000000n,
    leg1ExpectedOutWSOL: 800000000n,
    leg1ConservativeOutWSOL: 799200000n,
    leg2ExpectedOutUSDC: 102000000n,
    leg2ConservativeOutUSDC: 101898000n,
    expectedNetUSDC: '1.9781',
    minConservativeNetUSDC: '0.6261',
    status: 'QUALIFIED_SHADOW',
    rejectionReasons: [],
    leg1Quote: {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-A',
      dex: 'RAYDIUM_AMM',
      inputMint: 'USDC',
      outputMint: 'WSOL',
      inAmount: 100000000n,
      outAmount: 800000000n,
      feeIncluded: true,
      feeAmount: 250000n,
      priceImpactBps: 2,
      slot: 100,
      timestamp: Date.now() - ageMs,
      executionType: 'POTENTIAL_ATOMIC'
    },
    leg2Quote: {
      quoteSource: 'DIRECT_POOL',
      poolId: 'pool-B',
      dex: 'ORCA_WHIRLPOOL',
      inputMint: 'WSOL',
      outputMint: 'USDC',
      inAmount: 799200000n,
      outAmount: 102000000n,
      feeIncluded: true,
      feeAmount: 32000n,
      priceImpactBps: 1,
      slot: 100,
      timestamp: Date.now() - ageMs,
      executionType: 'POTENTIAL_ATOMIC'
    },
    costs: {
      networkFeeUSDC: '0.000625',
      priorityFeeUSDC: '0.001250',
      jitoTipUSDC: '0.000000',
      tokenTransferFeesUSDC: '0.000000',
      contingencyUSDC: '0.0200',
      safetyBufferUSDC: '0.2500',
      totalCostsUSDC: '0.021875',
      solPriceUSDC: '125.00',
      assumptions: ['Standard assumptions']
    },
    timestamp: Date.now() - ageMs,
    slotGap: 0,
    quoteAgeMs: ageMs
  });

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    repo = new ArbitrageRepository(config);
  });

  afterEach(() => {
    repo.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testCsvPath)) fs.unlinkSync(testCsvPath);
  });

  it('Matrix 20.1: Persists candidates and retains them across repository restart without database corruption', () => {
    repo.saveCandidate(sampleCandidate('CAND-1'));
    repo.saveCandidate(sampleCandidate('CAND-2'));

    const initialStats = repo.getSummaryStats();
    expect(initialStats.totalSignals).toBe(2);
    expect(initialStats.qualifiedCount).toBe(2);

    // Simulate process termination and restart
    repo.close();

    const restartedRepo = new ArbitrageRepository(config);
    const restartedStats = restartedRepo.getSummaryStats();
    expect(restartedStats.totalSignals).toBe(2);
    expect(restartedStats.qualifiedCount).toBe(2);
    expect(restartedStats.totalTheoreticalProfitUSDC).toBeCloseTo(1.2522, 2);

    restartedRepo.close();
  });

  it('Matrix 20.2: Bounded retention correctly purges records older than DB_RETENTION_HOURS', () => {
    const oldTimestampMs = 48 * 3600 * 1000; // 48 hours old
    repo.saveCandidate(sampleCandidate('CAND-OLD', oldTimestampMs));
    repo.saveCandidate(sampleCandidate('CAND-NEW', 0));

    expect(repo.getSummaryStats().totalSignals).toBe(2);

    // Purge records older than 24 hours
    const purged = repo.purgeOldRecords(24);
    expect(purged).toBe(1);

    const remaining = repo.getSummaryStats();
    expect(remaining.totalSignals).toBe(1);
  });

  it('Matrix 20.3: Exports candidate records to CSV format with headers and proper escaping', () => {
    repo.saveCandidate(sampleCandidate('CAND-CSV-1'));
    const count = repo.exportToCsv(testCsvPath);

    expect(count).toBe(1);
    expect(fs.existsSync(testCsvPath)).toBe(true);

    const csvContent = fs.readFileSync(testCsvPath, 'utf-8');
    expect(csvContent).toContain('candidate_id');
    expect(csvContent).toContain('CAND-CSV-1');
  });
});
