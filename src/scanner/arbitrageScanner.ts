import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { AppConfig } from '../config/index.js';
import {
  SwapQuote,
  ArbitrageCandidate,
  ScanHealthStatus,
  PoolState,
  RejectionReasonCode
} from '../types/index.js';
import { SolanaRpcProvider } from '../providers/solanaRpc.js';
import { SolanaWsProvider } from '../providers/solanaWs.js';
import { JupiterClient } from '../providers/jupiterClient.js';
import { dexRegistry } from '../dex/index.js';
import { PoolRegistry } from './poolRegistry.js';
import { StateCache } from './stateCache.js';
import { CostModel } from '../profit/costModel.js';
import { ArbitrageProfitCalculator } from '../profit/calculator.js';
import { ArbitrageRepository } from '../storage/repository.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../config/index.js';

export type CandidateListener = (candidate: ArbitrageCandidate) => void;

export class ArbitrageScanner {
  private config: AppConfig;
  private rpc: SolanaRpcProvider;
  private ws: SolanaWsProvider;
  private jupiter: JupiterClient;
  private poolRegistry: PoolRegistry;
  private stateCache: StateCache;
  private costModel: CostModel;
  private calculator: ArbitrageProfitCalculator;
  private repository: ArbitrageRepository;

  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private candidateListeners: CandidateListener[] = [];
  private vaultToPool = new Map<string, { poolId: string; isA: boolean }>();

  private qualifiedCount = 0;
  private rejectedCount = 0;
  private rejectionBreakdown: Record<string, number> = {};
  private quotesProducedCount = 0;
  private lastQuoteCountResetTime = Date.now();
  private currentQuotesPerSec = 0;

  private auditMetrics = {
    totalEvaluated: 0,
    uniqueOpportunities: 0,
    candidatesGrossPositive: 0,
    candidatesConservativeQualified: 0,
    rejectedRoutes: 0,
    quoteValidationFailures: 0,
    unsupportedRoutes: 0,
    staleDataRejections: 0
  };

  private currentSolPriceUSDC = new Decimal(125.0);
  private lastSolPriceTime = 0;

  constructor(
    config: AppConfig,
    customRpc?: SolanaRpcProvider,
    customWs?: SolanaWsProvider,
    customJupiter?: JupiterClient,
    customRepo?: ArbitrageRepository
  ) {
    this.config = config;
    this.rpc = customRpc || new SolanaRpcProvider(config);
    this.ws = customWs || new SolanaWsProvider(config);
    this.jupiter = customJupiter || new JupiterClient(config);
    this.poolRegistry = new PoolRegistry();
    this.stateCache = new StateCache();
    this.costModel = new CostModel(config);
    this.calculator = new ArbitrageProfitCalculator(config);
    this.repository = customRepo || new ArbitrageRepository(config);

    // Setup WS disconnect/reconnect hooks
    this.ws.onDisconnect(() => {
      this.stateCache.invalidateAll('DISCONNECTED');
      this.repository.logProviderEvent('SolanaWs', 'DISCONNECTED', undefined, this.ws.getCurrentSlot(), 'WebSocket feed disconnected; state cache invalidated');
    });

    this.ws.onReconnect(async () => {
      this.repository.logProviderEvent('SolanaWs', 'RECONNECTED', undefined, this.ws.getCurrentSlot(), 'WebSocket reconnected; refreshing snapshots');
      await this.refreshAllPoolStates();
    });

    this.ws.onSlot((slot) => {
      this.ws.setSlot(slot);
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Connect to WebSocket
    await this.ws.connect();

    // Fetch initial slot and pools snapshot
    try {
      const initialSlot = await this.rpc.getSlot();
      this.ws.setSlot(initialSlot);
      await this.refreshSolPrice();
      await this.refreshAllPoolStates();
    } catch {
      // Continue even if initial RPC failed; scanner will retry on timer
    }

    // Subscribe to pool updates via WS
    for (const pool of this.poolRegistry.getAllPools()) {
      this.ws.subscribeAccount(pool.id, (buffer, slot) => {
        this.handlePoolAccountUpdate(pool.id, buffer, slot);
      });
    }

    // Start periodic scanning cycle
    this.scanTimer = setInterval(() => {
      this.runScanCycle().catch(() => {});
    }, this.config.POLL_INTERVAL_MS);

    // Start health check / stats interval
    setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastQuoteCountResetTime) / 1000;
      if (elapsed > 0) {
        this.currentQuotesPerSec = Math.round(this.quotesProducedCount / elapsed);
        this.quotesProducedCount = 0;
        this.lastQuoteCountResetTime = now;
      }
    }, 5000);
  }

  public async refreshSolPrice(): Promise<void> {
    try {
      // Fetch fresh SOL/USDC price via 1 SOL quote
      const oneSolLamports = 1000000000n;
      const quote = await this.jupiter.getQuote(
        CANONICAL_WSOL_MINT,
        CANONICAL_USDC_MINT,
        oneSolLamports
      );
      if (quote && quote.outAmount > 0n) {
        this.currentSolPriceUSDC = new Decimal(quote.outAmount.toString()).div(1e6);
        this.lastSolPriceTime = Date.now();
      }
    } catch {
      // Keep last known valid price
    }
  }

  public async refreshAllPoolStates(): Promise<void> {
    const pools = this.poolRegistry.getAllPools();
    const pubkeys = pools.map(p => new PublicKey(p.id));

    try {
      const accounts = await this.rpc.getMultipleAccounts(pubkeys);
      const currentSlot = this.ws.getCurrentSlot();
      const decodedPools: PoolState[] = [];
      const vaultsToFetch: { pubkey: PublicKey; poolIndex: number; isA: boolean }[] = [];

      for (let i = 0; i < pools.length; i++) {
        const poolConfig = pools[i];
        const accountInfo = accounts[i];
        if (!accountInfo) continue;

        const adapter = dexRegistry.getAdapter(poolConfig.dex);
        if (adapter) {
          const decoded = adapter.decodePoolState(accountInfo.data, poolConfig.id, currentSlot);
          if (decoded) {
            const extra = decoded.extraData as any;
            const vaultA = extra?.baseVault || extra?.tokenVaultA || extra?.reserveX;
            const vaultB = extra?.quoteVault || extra?.tokenVaultB || extra?.reserveY;

            if (vaultA && vaultB) {
              if (!this.vaultToPool.has(vaultA)) {
                this.vaultToPool.set(vaultA, { poolId: decoded.id, isA: true });
                this.ws.subscribeAccount(vaultA, (buf, s) => this.handleVaultAccountUpdate(vaultA, buf, s));
              }
              if (!this.vaultToPool.has(vaultB)) {
                this.vaultToPool.set(vaultB, { poolId: decoded.id, isA: false });
                this.ws.subscribeAccount(vaultB, (buf, s) => this.handleVaultAccountUpdate(vaultB, buf, s));
              }

              vaultsToFetch.push({ pubkey: new PublicKey(vaultA), poolIndex: decodedPools.length, isA: true });
              vaultsToFetch.push({ pubkey: new PublicKey(vaultB), poolIndex: decodedPools.length, isA: false });
            }
            decodedPools.push(decoded);
          }
        }
      }

      // Fetch all vault accounts in a single batch RPC request (avoids 429 rate limit errors)
      if (vaultsToFetch.length > 0) {
        try {
          const vaultAccounts = await this.rpc.getMultipleAccounts(vaultsToFetch.map(v => v.pubkey));
          for (let i = 0; i < vaultsToFetch.length; i++) {
            const vInfo = vaultsToFetch[i];
            const acc = vaultAccounts[i];
            if (acc && acc.data.length >= 72) {
              const amount = acc.data.readBigUInt64LE(64);
              const pool = decodedPools[vInfo.poolIndex];
              if (pool) {
                if (vInfo.isA) pool.reserveA = amount;
                else pool.reserveB = amount;
              }
            }
          }
        } catch {
          // If batch vault fetch fails, preserve current state
        }
      }

      for (const pool of decodedPools) {
        const existing = this.stateCache.getPoolState(pool.id);
        if (existing) {
          if (pool.reserveA === 0n && (existing.reserveA ?? 0n) > 0n) pool.reserveA = existing.reserveA;
          if (pool.reserveB === 0n && (existing.reserveB ?? 0n) > 0n) pool.reserveB = existing.reserveB;
        }
        this.stateCache.setPoolState(pool);
      }
    } catch {
      // Handled gracefully
    }
  }

  private handleVaultAccountUpdate(vaultPubkey: string, data: Buffer, slot: number): void {
    // Parse raw SPL token account balance at offset 64 (u64, 8 bytes)
    if (data.length >= 72) {
      try {
        const rawAmount = data.readBigUInt64LE(64);
        const mapping = this.vaultToPool.get(vaultPubkey);
        if (mapping) {
          const pool = this.stateCache.getPoolState(mapping.poolId);
          if (pool) {
            if (mapping.isA) pool.reserveA = rawAmount;
            else pool.reserveB = rawAmount;
            pool.slot = slot;
            pool.receivedAt = Date.now();

            // Only evaluate if both reserves are populated for AMM pools
            if (pool.dex !== 'RAYDIUM_AMM' || ((pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n)) {
              this.evaluatePoolAgainstOthers(pool).catch(() => {});
            }
          }
        }
      } catch {}
    }
  }

  private handlePoolAccountUpdate(poolId: string, data: Buffer, slot: number): void {
    const poolConfig = this.poolRegistry.getPool(poolId);
    if (!poolConfig) return;

    const adapter = dexRegistry.getAdapter(poolConfig.dex);
    if (!adapter) return;

    const decoded = adapter.decodePoolState(data, poolId, slot);
    if (decoded) {
      const existing = this.stateCache.getPoolState(poolId);
      if (existing) {
        if (decoded.reserveA === 0n && (existing.reserveA ?? 0n) > 0n) {
          decoded.reserveA = existing.reserveA;
        }
        if (decoded.reserveB === 0n && (existing.reserveB ?? 0n) > 0n) {
          decoded.reserveB = existing.reserveB;
        }
      }
      this.stateCache.setPoolState(decoded);
      // Trigger evaluation for this updated pool only if hydrated
      if (decoded.dex !== 'RAYDIUM_AMM' || ((decoded.reserveA ?? 0n) > 0n && (decoded.reserveB ?? 0n) > 0n)) {
        this.evaluatePoolAgainstOthers(decoded).catch(() => {});
      }
    }
  }

  public async runScanCycle(): Promise<void> {
    await this.refreshSolPrice();
    const allStates = this.stateCache.getAllPoolStates();

    // If direct pool states are not yet hydrated, attempt refresh
    if (allStates.length < 2) {
      await this.refreshAllPoolStates();
    }

    const currentStates = this.stateCache.getAllPoolStates();
    for (let i = 0; i < currentStates.length; i++) {
      for (let j = 0; j < currentStates.length; j++) {
        if (i === j) continue;
        await this.evaluatePair(currentStates[i], currentStates[j]);
      }
    }
    this.repository.recordAuditMetrics(this.auditMetrics);
  }

  private async evaluatePoolAgainstOthers(updatedPool: PoolState): Promise<void> {
    const allStates = this.stateCache.getAllPoolStates();
    for (const other of allStates) {
      if (other.id === updatedPool.id) continue;
      await this.evaluatePair(updatedPool, other);
      await this.evaluatePair(other, updatedPool);
    }
  }

  private async evaluatePair(poolA: PoolState, poolB: PoolState): Promise<void> {
    // Distinct pool verification
    if (poolA.id === poolB.id) return;

    const adapterA = dexRegistry.getAdapter(poolA.dex);
    const adapterB = dexRegistry.getAdapter(poolB.dex);

    // Calculate current execution costs
    const costResult = this.costModel.calculateCosts({
      solPriceUSDC: this.currentSolPriceUSDC,
      solPriceTimestamp: this.lastSolPriceTime
    });

    const currentSlot = this.ws.getCurrentSlot();
    const wsConnected = this.ws.getHealth() !== 'DISCONNECTED';

    // Test each configured trade size in USDC
    for (const sizeUSDC of this.config.parsedTradeSizesUSDC) {
      // Input in integer micro-USDC (6 decimals)
      const inputAmountUSDC = BigInt(Math.floor(sizeUSDC * 1e6));

      // Leg 1: USDC -> WSOL against Pool A
      let leg1Quote: SwapQuote | null = null;
      if (adapterA) {
        leg1Quote = adapterA.quoteExactInput(poolA, CANONICAL_USDC_MINT, inputAmountUSDC);
      } else {
        // Route through Jupiter for venues without direct on-chain math adapters
        leg1Quote = await this.jupiter.getQuote(CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT, inputAmountUSDC);
      }
      if (!leg1Quote) continue;

      this.quotesProducedCount++;

      // Downside slippage on Leg 1 output to get conservative WSOL input for Leg 2
      const slippage1 = (leg1Quote.outAmount * BigInt(this.config.SLIPPAGE_BPS_LEG1)) / 10000n;
      const conservativeWSOLIn = leg1Quote.outAmount - slippage1;
      if (conservativeWSOLIn <= 0n) continue;

      // Leg 2: WSOL -> USDC against Pool B
      let leg2Quote: SwapQuote | null = null;
      if (adapterB) {
        leg2Quote = adapterB.quoteExactInput(poolB, CANONICAL_WSOL_MINT, conservativeWSOLIn);
      } else {
        // Route through Jupiter for venues without direct on-chain math adapters
        leg2Quote = await this.jupiter.getQuote(CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, conservativeWSOLIn);
      }
      if (!leg2Quote) continue;

      this.quotesProducedCount++;

      // Increment total evaluations
      this.auditMetrics.totalEvaluated++;

      // Evaluate Candidate
      const candidate = this.calculator.evaluateCandidate({
        initialAmountUSDC: inputAmountUSDC,
        leg1Quote,
        leg2Quote,
        costs: costResult.breakdown,
        currentSlot,
        wsConnected,
        solPriceTimestamp: this.lastSolPriceTime
      });

      // Track gross profitability
      if (parseFloat(candidate.expectedNetUSDC) > 0) {
        this.auditMetrics.candidatesGrossPositive++;
      }

      // Deduplicate identical repeated opportunities
      const isDupe = this.stateCache.isDuplicate({
        route: `${poolA.id}->${poolB.id}`,
        amountUSDC: inputAmountUSDC,
        netProfitUSDC: candidate.minConservativeNetUSDC
      });

      if (!isDupe) {
        this.auditMetrics.uniqueOpportunities++;
      }

      // Track statistics and categorized audit metrics
      if (candidate.status === 'QUALIFIED_SHADOW') {
        this.qualifiedCount++;
        this.auditMetrics.candidatesConservativeQualified++;
      } else {
        this.rejectedCount++;
        this.auditMetrics.rejectedRoutes++;
        for (const reason of candidate.rejectionReasons) {
          this.rejectionBreakdown[reason] = (this.rejectionBreakdown[reason] || 0) + 1;
          if (reason === 'QUOTE_UNVERIFIED' || reason === 'MISSING_TICK_DATA') {
            this.auditMetrics.quoteValidationFailures++;
          }
          if (reason === 'UNSUPPORTED_ROUTE') {
            this.auditMetrics.unsupportedRoutes++;
          }
          if (reason === 'STALE_QUOTE' || reason === 'SLOT_MISMATCH' || reason === 'PRICE_CONVERSION_STALE') {
            this.auditMetrics.staleDataRejections++;
          }
        }
      }

      if (isDupe && candidate.status !== 'QUALIFIED_SHADOW') {
        continue;
      }

      // Persist in SQLite
      this.repository.saveCandidate(candidate);

      // Notify CLI listeners
      for (const listener of this.candidateListeners) {
        try { listener(candidate); } catch {}
      }
    }
  }

  public onCandidate(listener: CandidateListener): void {
    this.candidateListeners.push(listener);
  }

  public getHealthStatus(): ScanHealthStatus {
    const wsStats = this.ws.getStats();
    const jupStats = this.jupiter.getStats();
    const allStates = this.stateCache.getAllPoolStates();

    const poolsPerDex: Record<string, number> = {};
    for (const pool of allStates) {
      poolsPerDex[pool.dex] = (poolsPerDex[pool.dex] || 0) + 1;
    }

    return {
      connectedRpc: this.rpc.getStats().requestsFailed === 0 || this.rpc.getStats().requestsTotal > 0,
      connectedWs: wsStats.connected,
      jupiterStatus: jupStats.rateLimitHits > 0 ? 'RATE_LIMITED' : 'OK',
      currentSlot: wsStats.lastSlot,
      lastSlotUpdateTime: wsStats.lastMessageTime,
      quotesPerSecond: this.currentQuotesPerSec,
      qualifiedCount: this.qualifiedCount,
      rejectedCount: this.rejectedCount,
      rejectionBreakdown: { ...this.rejectionBreakdown },
      activePoolCount: allStates.length,
      poolsPerDex
    };
  }

  public getAuditMetrics() {
    return { ...this.auditMetrics };
  }

  public getRepository(): ArbitrageRepository {
    return this.repository;
  }

  public stop(): void {
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.ws.disconnect();
  }
}
