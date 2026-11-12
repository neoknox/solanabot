import { PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { SolanaRpcProvider } from '../providers/solanaRpc.js';
import {
  CompetitorActivityMetrics,
  FeeDistribution,
  ContentionLevel
} from '../types/index.js';

// Canonical Jito Tip Accounts on Solana Mainnet
export const CANONICAL_JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTxvQssQn1WNVJFgyDxzsLNLm36cqm5mqM4s',
  'Cw8CFyM9FkoMi7K7Crndab3hmysSkWa7LgzKwDpCfvWm',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pWHLrwyeP4AJuAW45KXt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
]);

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

export interface ParsedTxSample {
  signature: string;
  slot: number;
  err: any;
  feeLamports: number;
  priorityFeeMicroLamports: number;
  jitoTipLamports: number;
  isArbitrageLoop: boolean;
  timestamp: number;
}

export class CompetitorAnalyzer {
  private rpc?: SolanaRpcProvider;
  private cache = new Map<string, CompetitorActivityMetrics>();

  constructor(rpc?: SolanaRpcProvider) {
    this.rpc = rpc;
  }

  /**
   * Parses raw transaction metadata to extract verifiable competition metrics
   */
  public parseTransactionMetadata(tx: {
    signature: string;
    slot: number;
    err?: any;
    fee?: number;
    instructions?: Array<{ programId: string; data?: string; accounts?: string[] }>;
    accountKeys?: Array<{ pubkey: string }>;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }>;
    blockTime?: number | null;
  }): ParsedTxSample {
    const feeLamports = tx.fee ?? 5000;
    let priorityFeeMicroLamports = 0;
    let jitoTipLamports = 0;
    let isArbitrageLoop = false;

    // 1. Detect ComputeBudget SetComputeUnitPrice (priority fee)
    if (tx.instructions) {
      for (const ix of tx.instructions) {
        if (ix.programId === COMPUTE_BUDGET_PROGRAM_ID && ix.data) {
          try {
            const buf = Buffer.from(ix.data, 'base64');
            // Opcode 3: SetComputeUnitPrice (1 byte opcode + 8 bytes u64 micro-lamports)
            if (buf.length >= 9 && buf[0] === 3) {
              priorityFeeMicroLamports = Number(buf.readBigUInt64LE(1));
            }
          } catch {}
        }
      }
    }

    // 2. Detect Jito tip transfers
    if (tx.accountKeys && tx.preBalances && tx.postBalances) {
      for (let i = 0; i < tx.accountKeys.length; i++) {
        const pubkey = tx.accountKeys[i].pubkey;
        if (CANONICAL_JITO_TIP_ACCOUNTS.has(pubkey)) {
          const pre = tx.preBalances[i] || 0;
          const post = tx.postBalances[i] || 0;
          if (post > pre) {
            jitoTipLamports = post - pre;
          }
        }
      }
    }

    // 3. Detect circular arbitrage loop (token A -> token B -> token A)
    if (tx.preTokenBalances && tx.postTokenBalances) {
      const owners = new Set(tx.preTokenBalances.map(b => b.owner).filter(Boolean));
      for (const owner of owners) {
        const preMints = tx.preTokenBalances.filter(b => b.owner === owner).map(b => b.mint);
        const postMints = tx.postTokenBalances.filter(b => b.owner === owner).map(b => b.mint);
        // An arbitrageur starts and ends with the exact same token inventory
        const commonMints = preMints.filter(m => postMints.includes(m));
        if (commonMints.length >= 1 && preMints.length >= 2) {
          isArbitrageLoop = true;
          break;
        }
      }
    }

    return {
      signature: tx.signature,
      slot: tx.slot,
      err: tx.err ?? null,
      feeLamports,
      priorityFeeMicroLamports,
      jitoTipLamports,
      isArbitrageLoop,
      timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now()
    };
  }

  /**
   * Computes a deterministic historical competition score and statistics from parsed samples
   */
  public computeMetrics(poolId: string, samples: ParsedTxSample[]): CompetitorActivityMetrics {
    if (samples.length === 0) {
      return this.getDefaultMetrics(poolId);
    }

    const totalObservedTx = samples.length;
    const failedTxCount = samples.filter(s => s.err !== null).length;
    const successfulTxCount = totalObservedTx - failedTxCount;
    const failureRate = totalObservedTx > 0 ? failedTxCount / totalObservedTx : 0;

    // Fee distribution
    const fees = samples.map(s => s.feeLamports).sort((a, b) => a - b);
    const feeDistributionLamports = this.calculateDistribution(fees);

    // Priority fee distribution
    const priorityFees = samples.map(s => s.priorityFeeMicroLamports).sort((a, b) => a - b);
    const priorityFeeStatsMicroLamports = this.calculateDistribution(priorityFees);

    // Jito tip metrics
    const jitoTips = samples.map(s => s.jitoTipLamports).filter(t => t > 0).sort((a, b) => a - b);
    const jitoTipCount = jitoTips.length;
    const jitoTipDistributionLamports = {
      min: jitoTips[0] || 0,
      p50: jitoTips[Math.floor(jitoTips.length * 0.5)] || 0,
      p95: jitoTips[Math.floor(jitoTips.length * 0.95)] || 0,
      max: jitoTips[jitoTips.length - 1] || 0
    };

    // Arbitrage loop frequency
    const arbLoops = samples.filter(s => s.isArbitrageLoop).length;
    const oldestTime = Math.min(...samples.map(s => s.timestamp));
    const newestTime = Math.max(...samples.map(s => s.timestamp));
    const windowSec = Math.max(1, (newestTime - oldestTime) / 1000);
    const arbitrageLoopFrequencyPerHour = Number(((arbLoops / windowSec) * 3600).toFixed(2));

    // Contention Level determination
    let contentionLevel: ContentionLevel = 'UNKNOWN';
    if (totalObservedTx >= 40) contentionLevel = 'EXTREME';
    else if (totalObservedTx >= 20) contentionLevel = 'HIGH';
    else if (totalObservedTx >= 8) contentionLevel = 'MEDIUM';
    else if (totalObservedTx >= 1) contentionLevel = 'LOW';

    // Deterministic Historical Competition Score (0 to 100)
    // 1. Contention factor: 0-35 pts
    const contentionPts = Math.min(35, totalObservedTx * 1.5);

    // 2. Priority fee pressure: 0-30 pts (normalized against 200,000 micro-lamports)
    const priorityPts = Math.min(30, (priorityFeeStatsMicroLamports.p50 / 200000) * 30);

    // 3. Collision failure rate: 0-20 pts (high failures indicate heavy sandwich/arb collision)
    const failurePts = Math.min(20, failureRate * 25);

    // 4. Jito tip searcher activity: 0-15 pts
    const jitoPts = Math.min(15, (jitoTipCount / totalObservedTx) * 30);

    const competitionScore = Math.min(100, Math.round(contentionPts + priorityPts + failurePts + jitoPts));

    const metrics: CompetitorActivityMetrics = {
      poolId,
      totalObservedTx,
      successfulTxCount,
      failedTxCount,
      failureRate: Number(failureRate.toFixed(4)),
      feeDistributionLamports,
      priorityFeeStatsMicroLamports,
      jitoTipCount,
      jitoTipDistributionLamports,
      contentionLevel,
      historicalCompetitionScore: competitionScore,
      arbitrageLoopFrequencyPerHour,
      sampleWindowSeconds: Math.round(windowSec),
      lastAnalyzedSlot: Math.max(...samples.map(s => s.slot)),
      timestamp: Date.now()
    };

    this.cache.set(poolId, metrics);
    return metrics;
  }

  private calculateDistribution(sortedValues: number[]): FeeDistribution {
    if (sortedValues.length === 0) {
      return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
    }
    const count = sortedValues.length;
    const min = sortedValues[0];
    const max = sortedValues[count - 1];
    const sum = sortedValues.reduce((a, b) => a + b, 0);
    const mean = Math.round(sum / count);
    const p50 = sortedValues[Math.floor(count * 0.50)];
    const p95 = sortedValues[Math.floor(count * 0.95)] || max;

    return { min, p50, p95, max, mean };
  }

  public getCachedMetrics(poolId: string): CompetitorActivityMetrics {
    return this.cache.get(poolId) || this.getDefaultMetrics(poolId);
  }

  public getDefaultMetrics(poolId: string): CompetitorActivityMetrics {
    return {
      poolId,
      totalObservedTx: 0,
      successfulTxCount: 0,
      failedTxCount: 0,
      failureRate: 0,
      feeDistributionLamports: { min: 0, p50: 0, p95: 0, max: 0, mean: 0 },
      priorityFeeStatsMicroLamports: { min: 0, p50: 0, p95: 0, max: 0, mean: 0 },
      jitoTipCount: 0,
      jitoTipDistributionLamports: { min: 0, p50: 0, p95: 0, max: 0 },
      contentionLevel: 'UNKNOWN',
      historicalCompetitionScore: 0, // Unsampled: 0 transactions observed
      arbitrageLoopFrequencyPerHour: 0,
      sampleWindowSeconds: 0,
      lastAnalyzedSlot: 0,
      timestamp: Date.now()
    };
  }
}
