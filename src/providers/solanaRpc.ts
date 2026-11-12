import { Connection, PublicKey, AccountInfo, RpcResponseAndContext } from '@solana/web3.js';
import { AppConfig } from '../config/index.js';

export interface RpcStats {
  requestsTotal: number;
  requestsFailed: number;
  rateLimitHits: number;
  lastSlot: number;
  lastLatencyMs: number;
}

export class SolanaRpcProvider {
  private connection: Connection;
  private config: AppConfig;
  private stats: RpcStats = {
    requestsTotal: 0,
    requestsFailed: 0,
    rateLimitHits: 0,
    lastSlot: 0,
    lastLatencyMs: 0
  };
  private minIntervalMs: number;
  private lastRequestTime = 0;

  constructor(config: AppConfig, customConnection?: Connection) {
    this.config = config;
    this.connection = customConnection || new Connection(config.SOLANA_RPC_HTTP, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 10000
    });
    this.minIntervalMs = 1000 / config.RPC_RATE_LIMIT_RPS;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  public async getSlot(): Promise<number> {
    await this.throttle();
    const start = Date.now();
    try {
      this.stats.requestsTotal++;
      const slot = await this.connection.getSlot('confirmed');
      this.stats.lastSlot = slot;
      this.stats.lastLatencyMs = Date.now() - start;
      return slot;
    } catch (err: unknown) {
      this.stats.requestsFailed++;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429') || message.includes('Too many requests')) {
        this.stats.rateLimitHits++;
      }
      throw err;
    }
  }

  public async getAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    await this.throttle();
    const start = Date.now();
    try {
      this.stats.requestsTotal++;
      const info = await this.connection.getAccountInfo(pubkey, 'confirmed');
      this.stats.lastLatencyMs = Date.now() - start;
      return info;
    } catch (err: unknown) {
      this.stats.requestsFailed++;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429')) this.stats.rateLimitHits++;
      throw err;
    }
  }

  public async getMultipleAccounts(pubkeys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    if (pubkeys.length === 0) return [];
    await this.throttle();
    const start = Date.now();
    try {
      this.stats.requestsTotal++;
      const accounts = await this.connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
      this.stats.lastLatencyMs = Date.now() - start;
      return accounts;
    } catch (err: unknown) {
      this.stats.requestsFailed++;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429')) this.stats.rateLimitHits++;
      throw err;
    }
  }

  public async getTokenAccountBalance(pubkey: PublicKey): Promise<{ amount: bigint; decimals: number }> {
    await this.throttle();
    try {
      this.stats.requestsTotal++;
      const balance = await this.connection.getTokenAccountBalance(pubkey, 'confirmed');
      return {
        amount: BigInt(balance.value.amount),
        decimals: balance.value.decimals
      };
    } catch (err: unknown) {
      this.stats.requestsFailed++;
      throw err;
    }
  }

  public async getEstimatePriorityFee(): Promise<number> {
    try {
      await this.throttle();
      const fees = await this.connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return this.config.PRIORITY_FEE_LAMPORTS;
      // Calculate median prioritization fee
      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 0;
      return Math.max(median, this.config.PRIORITY_FEE_LAMPORTS);
    } catch {
      return this.config.PRIORITY_FEE_LAMPORTS;
    }
  }

  public getStats(): RpcStats {
    return { ...this.stats };
  }

  public getConnection(): Connection {
    return this.connection;
  }
}
