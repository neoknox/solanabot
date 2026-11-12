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
import { RouteIndex, IndexedDirectedRoute } from './routeIndex.js';
import { BoundedEventQueue, QueuedAccountUpdate } from './eventQueue.js';
import { LatencyTracker, LatencyReport } from '../telemetry/latencyTracker.js';

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

  // Performance Hardening Components
  private routeIndex: RouteIndex;
  private eventQueue: BoundedEventQueue;
  private latencyTracker: LatencyTracker;
  private isDrainingQueue = false;

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

    // Initialize Route Index & Performance Pipelines
    this.routeIndex = new RouteIndex(this.poolRegistry.getAllPools());
    this.eventQueue = new BoundedEventQueue(config.MAX_EVENT_QUEUE_CAPACITY || 2000);
    this.latencyTracker = new LatencyTracker();

    // Setup WS disconnect/reconnect hooks
    this.ws.onDisconnect(() => {
      this.stateCache.invalidateAll('DISCONNECTED');
      this.repository.logProviderEvent(
        'SolanaWs',
        'DISCONNECTED',
        undefined,
        this.ws.getCurrentSlot(),
        'WebSocket feed disconnected; state cache invalidated'
      );
    });

    this.ws.onReconnect(async () => {
      const reconnectStart = performance.now();
      this.repository.logProviderEvent(
        'SolanaWs',
        'RECONNECTED',
        undefined,
        this.ws.getCurrentSlot(),
        'WebSocket reconnected; refreshing snapshots'
      );
      await this.refreshAllPoolStates();
      this.latencyTracker.recordReconnectDuration(performance.now() - reconnectStart);
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

    // Fetch initial slot and pool snapshot
    try {
      const initialSlot = await this.rpc.getSlot();
      this.ws.setSlot(initialSlot);
      await this.refreshSolPrice();
      await this.refreshAllPoolStates();
    } catch {
      // Continue even if initial RPC failed; scanner will retry on timer
    }

    // Subscribe to pool updates via WS with microsecond timing
    for (const pool of this.poolRegistry.getAllPools()) {
      this.ws.subscribeAccount(pool.id, (buffer, slot, rxTime, monoTime) => {
        this.enqueueUpdate({
          type: 'POOL_ACCOUNT',
          key: pool.id,
          data: buffer,
          slot,
          receivedAtMs: rxTime || Date.now(),
          monotonicReceiptTime: monoTime || performance.now()
        });
      });
    }

    // Start background event loop & periodic scan cycle
    this.scanTimer = setInterval(() => {
      this.runScanCycle().catch(() => {});
    }, this.config.SCAN_INTERVAL_MS || 500);

    // Periodic throughput measurement
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

  public enqueueUpdate(update: QueuedAccountUpdate): void {
    this.eventQueue.enqueue(update);
    this.scheduleQueueDrain();
  }

  private scheduleQueueDrain(): void {
    if (this.isDrainingQueue) return;
    this.isDrainingQueue = true;
    setImmediate(() => {
      this.drainQueue()
        .catch(() => {})
        .finally(() => {
          this.isDrainingQueue = false;
          if (!this.eventQueue.isEmpty()) {
            this.scheduleQueueDrain();
          }
        });
    });
  }

  private async drainQueue(): Promise<void> {
    while (!this.eventQueue.isEmpty()) {
      const update = this.eventQueue.dequeue();
      if (!update) break;

      if (update.type === 'POOL_ACCOUNT') {
        this.processPoolAccountUpdate(update);
      } else if (update.type === 'VAULT_ACCOUNT') {
        this.processVaultAccountUpdate(update);
      }
    }
  }

  private processPoolAccountUpdate(update: QueuedAccountUpdate): void {
    const poolConfig = this.poolRegistry.getPool(update.key);
    if (!poolConfig) return;

    const adapter = dexRegistry.getAdapter(poolConfig.dex);
    if (!adapter) return;

    const decodeStart = performance.now();
    const decoded = adapter.decodePoolState(update.data, update.key, update.slot);
    this.latencyTracker.recordDecodeDuration((performance.now() - decodeStart) * 1000);

    if (decoded) {
      decoded.receivedAt = update.receivedAtMs;

      // Extract real-time on-chain SOL price dynamically from Orca SOL/USDC Whirlpool sqrtPrice
      if (decoded.dex === 'ORCA_WHIRLPOOL' && decoded.tokenAMint === CANONICAL_WSOL_MINT) {
        const sqrtPriceStr = (decoded.extraData as any)?.sqrtPrice;
        if (sqrtPriceStr) {
          try {
            const sqrtP = BigInt(sqrtPriceStr);
            const Q64 = 1n << 64n;
            const priceRatio = Number(sqrtP) / Number(Q64);
            const calculatedSolPrice = (priceRatio * priceRatio) * 1000; // Adjust for 9 vs 6 decimals
            if (calculatedSolPrice > 10 && calculatedSolPrice < 10000) {
              this.currentSolPriceUSDC = new Decimal(calculatedSolPrice);
              this.lastSolPriceTime = update.receivedAtMs;
            }
          } catch {}
        }
      }

      // Preserve existing vault reserves
      const existing = this.stateCache.getPoolState(update.key);
      if (existing) {
        if (decoded.reserveA === 0n && (existing.reserveA ?? 0n) > 0n) decoded.reserveA = existing.reserveA;
        if (decoded.reserveB === 0n && (existing.reserveB ?? 0n) > 0n) decoded.reserveB = existing.reserveB;
      }
      this.stateCache.setPoolState(decoded);

      // Reevaluate only routes affected by this pool update
      if (decoded.dex !== 'RAYDIUM_AMM' || ((decoded.reserveA ?? 0n) > 0n && (decoded.reserveB ?? 0n) > 0n)) {
        this.evaluateAffectedRoutes(update.key, update.monotonicReceiptTime);
      }
    }
  }

  private processVaultAccountUpdate(update: QueuedAccountUpdate): void {
    if (update.data.length >= 72) {
      try {
        const rawAmount = update.data.readBigUInt64LE(64);
        const mapping = this.vaultToPool.get(update.key);
        if (mapping) {
          const pool = this.stateCache.getPoolState(mapping.poolId);
          if (pool) {
            if (mapping.isA) pool.reserveA = rawAmount;
            else pool.reserveB = rawAmount;
            pool.slot = update.slot;
            pool.receivedAt = update.receivedAtMs;

            // Reevaluate only routes affected by this vault update
            if (pool.dex !== 'RAYDIUM_AMM' || ((pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n)) {
              this.evaluateAffectedRoutes(mapping.poolId, update.monotonicReceiptTime);
            }
          }
        }
      } catch {}
    }
  }

  private evaluateAffectedRoutes(poolId: string, monotonicReceiptTime?: number): void {
    const affectedRoutes = this.routeIndex.getRoutesAffectedByPool(poolId);
    for (const route of affectedRoutes) {
      this.evaluateIndexedRoute(route, monotonicReceiptTime);
    }
  }

  private evaluateIndexedRoute(route: IndexedDirectedRoute, monotonicReceiptTime?: number): void {
    const poolA = this.stateCache.getPoolState(route.poolAId);
    const poolB = this.stateCache.getPoolState(route.poolBId);
    if (!poolA || !poolB) return;

    // Fail closed if AMM reserves are not yet hydrated
    if (poolA.dex === 'RAYDIUM_AMM' && ((poolA.reserveA ?? 0n) <= 0n || (poolA.reserveB ?? 0n) <= 0n)) return;
    if (poolB.dex === 'RAYDIUM_AMM' && ((poolB.reserveA ?? 0n) <= 0n || (poolB.reserveB ?? 0n) <= 0n)) return;

    const adapterA = dexRegistry.getAdapter(route.dexA);
    const adapterB = dexRegistry.getAdapter(route.dexB);
    if (!adapterA || !adapterB) return;

    const currentSlot = this.ws.getCurrentSlot();
    const wsConnected = this.ws.getHealth() !== 'DISCONNECTED';

    // Calculate current execution costs
    const costResult = this.costModel.calculateCosts({
      solPriceUSDC: this.currentSolPriceUSDC,
      solPriceTimestamp: this.lastSolPriceTime
    });

    for (const sizeUSDC of this.config.parsedTradeSizesUSDC) {
      const inputAmountUSDC = BigInt(Math.floor(sizeUSDC * 1e6));

      // Local high-speed math quoting
      const quoteStart = performance.now();
      const leg1Quote = adapterA.quoteExactInput(poolA, route.inputMint, inputAmountUSDC);
      if (!leg1Quote) continue;

      this.quotesProducedCount++;

      const slippage1 = (leg1Quote.outAmount * BigInt(this.config.SLIPPAGE_BPS_LEG1)) / 10000n;
      const conservativeWSOLIn = leg1Quote.outAmount - slippage1;
      if (conservativeWSOLIn <= 0n) continue;

      const leg2Quote = adapterB.quoteExactInput(poolB, route.intermediateMint, conservativeWSOLIn);
      if (!leg2Quote) continue;

      this.quotesProducedCount++;
      const quoteDurationUs = (performance.now() - quoteStart) * 1000;
      this.latencyTracker.recordQuoteDuration(quoteDurationUs);

      // Profit validation & audit metrics
      this.auditMetrics.totalEvaluated++;
      const validationStart = performance.now();
      const candidate = this.calculator.evaluateCandidate({
        initialAmountUSDC: inputAmountUSDC,
        leg1Quote,
        leg2Quote,
        costs: costResult.breakdown,
        currentSlot,
        wsConnected,
        solPriceTimestamp: this.lastSolPriceTime
      });
      const validationDurationUs = (performance.now() - validationStart) * 1000;
      this.latencyTracker.recordValidationDuration(validationDurationUs);

      // Total detection-to-decision latency
      if (monotonicReceiptTime) {
        const decisionDurationUs = (performance.now() - monotonicReceiptTime) * 1000;
        this.latencyTracker.recordDecisionDuration(decisionDurationUs);
      }

      this.latencyTracker.recordSlotLag(Math.max(0, currentSlot - poolA.slot));

      // Track gross profitability
      if (parseFloat(candidate.expectedNetUSDC) > 0) {
        this.auditMetrics.candidatesGrossPositive++;
      }

      // Deduplicate identical repeated opportunities
      const isDupe = this.stateCache.isDuplicate({
        route: route.routeId,
        amountUSDC: inputAmountUSDC,
        netProfitUSDC: candidate.minConservativeNetUSDC
      });

      if (!isDupe) {
        this.auditMetrics.uniqueOpportunities++;
      }

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

      // Asynchronous non-blocking persistence
      this.repository.saveCandidate(candidate);

      // Notify CLI listeners
      for (const listener of this.candidateListeners) {
        try { listener(candidate); } catch {}
      }
    }
  }

  public async refreshSolPrice(): Promise<void> {
    try {
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
      const rpcStart = performance.now();
      const accounts = await this.rpc.getMultipleAccounts(pubkeys);
      this.latencyTracker.recordRpcLatency(performance.now() - rpcStart);

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
                this.ws.subscribeAccount(vaultA, (buf, s, rxTime, monoTime) => {
                  this.enqueueUpdate({
                    type: 'VAULT_ACCOUNT',
                    key: vaultA,
                    data: buf,
                    slot: s,
                    receivedAtMs: rxTime || Date.now(),
                    monotonicReceiptTime: monoTime || performance.now()
                  });
                });
              }
              if (!this.vaultToPool.has(vaultB)) {
                this.vaultToPool.set(vaultB, { poolId: decoded.id, isA: false });
                this.ws.subscribeAccount(vaultB, (buf, s, rxTime, monoTime) => {
                  this.enqueueUpdate({
                    type: 'VAULT_ACCOUNT',
                    key: vaultB,
                    data: buf,
                    slot: s,
                    receivedAtMs: rxTime || Date.now(),
                    monotonicReceiptTime: monoTime || performance.now()
                  });
                });
              }

              vaultsToFetch.push({ pubkey: new PublicKey(vaultA), poolIndex: decodedPools.length, isA: true });
              vaultsToFetch.push({ pubkey: new PublicKey(vaultB), poolIndex: decodedPools.length, isA: false });
            }
            decodedPools.push(decoded);
          }
        }
      }

      // Batch vault balance hydration (avoids 429 rate limit issues)
      if (vaultsToFetch.length > 0) {
        try {
          const vRpcStart = performance.now();
          const vaultAccounts = await this.rpc.getMultipleAccounts(vaultsToFetch.map(v => v.pubkey));
          this.latencyTracker.recordRpcLatency(performance.now() - vRpcStart);

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
        } catch {}
      }

      for (const pool of decodedPools) {
        const existing = this.stateCache.getPoolState(pool.id);
        if (existing) {
          if (pool.reserveA === 0n && (existing.reserveA ?? 0n) > 0n) pool.reserveA = existing.reserveA;
          if (pool.reserveB === 0n && (existing.reserveB ?? 0n) > 0n) pool.reserveB = existing.reserveB;
        }
        this.stateCache.setPoolState(pool);
      }
    } catch {}
  }

  public async runScanCycle(): Promise<void> {
    const allStates = this.stateCache.getAllPoolStates();
    if (allStates.length < 2) {
      await this.refreshAllPoolStates();
    }

    const allRoutes = this.routeIndex.getAllRoutes();
    for (const route of allRoutes) {
      this.evaluateIndexedRoute(route);
    }
    this.repository.recordAuditMetrics(this.auditMetrics);
  }

  // Compatibility method for existing tests
  public async evaluatePair(poolA: PoolState, poolB: PoolState): Promise<void> {
    const route: IndexedDirectedRoute = {
      routeId: `${poolA.id}->${poolB.id}`,
      poolAId: poolA.id,
      poolBId: poolB.id,
      dexA: poolA.dex,
      dexB: poolB.dex,
      inputMint: CANONICAL_USDC_MINT,
      intermediateMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT,
      isDirectToDirect: true,
      priorityScore: 1000
    };
    this.evaluateIndexedRoute(route);
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

  public getLatencyReport(): LatencyReport {
    return this.latencyTracker.getReport();
  }

  public getEventQueueStats() {
    return this.eventQueue.getStats();
  }

  public getRouteIndex(): RouteIndex {
    return this.routeIndex;
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
    this.repository.flushSync();
  }
}
