import { Connection, PublicKey, AccountInfo, RpcResponseAndContext } from '@solana/web3.js';
import { AppConfig } from '../config/index.js';

export interface RpcStats {
  requestsTotal: number;
  requestsFailed: number;
  rateLimitHits: number;
  lastSlot: number;
  lastLatencyMs: number;
}

const DEFAULT_RPC_TIMEOUT_MS = 8000; // 8-second cancellable request timeout
const MAX_TOTAL_OPERATION_DEADLINE_MS = 30000; // 30-second total operation deadline

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
      confirmTransactionInitialTimeout: DEFAULT_RPC_TIMEOUT_MS,
      fetch: (url, options) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort(new Error(`RPC_TIMEOUT_${DEFAULT_RPC_TIMEOUT_MS}MS`));
        }, DEFAULT_RPC_TIMEOUT_MS);

        return fetch(url, {
          ...options,
          signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));
      }
    });
    this.minIntervalMs = 1000 / config.RPC_RATE_LIMIT_RPS;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS, opName = 'RPC_OP'): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${opName}_TIMEOUT_EXCEEDED_${timeoutMs}MS`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
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
      const slot = await this.withTimeout(this.connection.getSlot('confirmed'), DEFAULT_RPC_TIMEOUT_MS, 'GET_SLOT');
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
      const info = await this.withTimeout(this.connection.getAccountInfo(pubkey, 'confirmed'), DEFAULT_RPC_TIMEOUT_MS, 'GET_ACCOUNT_INFO');
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
    const res = await this.getMultipleAccountsAndContext(pubkeys);
    return res.value;
  }

  public async getMultipleAccountsAndContext(pubkeys: PublicKey[]): Promise<{ slot: number; value: (AccountInfo<Buffer> | null)[] }> {
    if (pubkeys.length === 0) return { slot: 0, value: [] };

    // Solana public RPC limits getMultipleAccounts to 100 pubkeys per request.
    // Chunk automatically to support arbitrary batch sizes without caller complexity.
    if (pubkeys.length > 100) {
      const CHUNK_SIZE = 100;
      const results: (AccountInfo<Buffer> | null)[] = [];
      let latestSlot = 0;
      for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
        const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
        const chunkRes = await this.getMultipleAccountsAndContext(chunk);
        results.push(...chunkRes.value);
        if (chunkRes.slot > latestSlot) latestSlot = chunkRes.slot;
      }
      return {
        slot: latestSlot,
        value: results
      };
    }

    await this.throttle();
    const start = Date.now();
    try {
      this.stats.requestsTotal++;
      const res = await this.withTimeout(
        this.connection.getMultipleAccountsInfoAndContext(pubkeys, 'confirmed'),
        DEFAULT_RPC_TIMEOUT_MS,
        'GET_MULTIPLE_ACCOUNTS'
      );
      this.stats.lastLatencyMs = Date.now() - start;
      this.stats.lastSlot = res.context.slot;
      return {
        slot: res.context.slot,
        value: res.value
      };
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
      const balance = await this.withTimeout(
        this.connection.getTokenAccountBalance(pubkey, 'confirmed'),
        DEFAULT_RPC_TIMEOUT_MS,
        'GET_TOKEN_BALANCE'
      );
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
      const fees = await this.withTimeout(
        this.connection.getRecentPrioritizationFees(),
        DEFAULT_RPC_TIMEOUT_MS,
        'GET_PRIORITY_FEES'
      );
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
