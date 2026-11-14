import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { AppConfig } from '../config/index.js';
import {
  SwapQuote,
  ArbitrageCandidate,
  ScanHealthStatus,
  PoolState,
  RejectionReasonCode,
  SurvivalStatus,
  CostBreakdown,
  AuditMetrics,
  VerifiedPoolRecord,
  RouteSummaryStats
} from '../types/index.js';
import { SolanaRpcProvider } from '../providers/solanaRpc.js';
import { SolanaWsProvider } from '../providers/solanaWs.js';
import { JupiterClient } from '../providers/jupiterClient.js';
import { dexRegistry } from '../dex/index.js';
import { PoolRegistry } from './poolRegistry.js';
import { loadDiscoveredCandidates } from './poolDiscovery.js';
import { StateCache } from './stateCache.js';
import { CostModel } from '../profit/costModel.js';
import { ArbitrageProfitCalculator } from '../profit/calculator.js';
import { ProfitThresholdManager } from '../profit/profitThresholdManager.js';
import { ArbitrageRepository } from '../storage/repository.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../config/index.js';
import { RouteIndex, IndexedDirectedRoute } from './routeIndex.js';
import { BoundedEventQueue, QueuedAccountUpdate } from './eventQueue.js';
import { LatencyTracker, LatencyReport } from '../telemetry/latencyTracker.js';
import { TradeSizer, QuoterLeg } from '../profit/tradeSizer.js';
import { CompetitorAnalyzer } from '../competition/analyzer.js';
import { CompetitionScorer } from '../profit/competitionScorer.js';
import { OpportunityTracker } from './opportunityTracker.js';
import {
  deriveTickArrayPda,
  decodeTickArrayAccount,
  getSurroundingTickArrayStartIndices,
  getRequiredTickArrayStartIndices,
  getTickArrayContentSignature
} from '../dex/orcaTickArray.js';
import { KNOWN_PROGRAM_IDS } from '../config/index.js';

export type CandidateListener = (candidate: ArbitrageCandidate) => void;

export class ArbitrageScanner {
  private config: AppConfig;
  private rpc: SolanaRpcProvider;
  private ws: SolanaWsProvider;
  private jupiter: JupiterClient;
  private poolRegistry: PoolRegistry;
  private stateCache: StateCache;
  private costModel: CostModel;
  private profitThresholdManager: ProfitThresholdManager;
  private calculator: ArbitrageProfitCalculator;
  private repository: ArbitrageRepository;
  private tradeSizer: TradeSizer;

  // Competition-Aware Intelligence Components
  private competitorAnalyzer: CompetitorAnalyzer;
  private competitionScorer: CompetitionScorer;
  private opportunityTracker: OpportunityTracker;

  // Performance Hardening & Routing Components
  private routeIndex: RouteIndex;
  private eventQueue: BoundedEventQueue;
  private latencyTracker: LatencyTracker;
  private isDrainingQueue = false;

  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private candidateListeners: CandidateListener[] = [];
  private vaultToPool = new Map<string, { poolId: string; isA: boolean }>();
  private openOrdersToPool = new Map<string, string>();
  private tickArrayToPool = new Map<string, { poolId: string; startTickIndex: number }>();

  private qualifiedCount = 0;
  private rejectedCount = 0;
  private rejectionBreakdown: Record<string, number> = {};
  private quotesProducedCount = 0;
  private lastQuoteCountResetTime = Date.now();
  private currentQuotesPerSec = 0;

  private auditMetrics: AuditMetrics = {
    totalEvaluated: 0,
    uniqueOpportunities: 0,
    candidatesGrossPositive: 0,
    candidatesConservativeQualified: 0,
    rejectedRoutes: 0,
    quoteValidationFailures: 0,
    unsupportedRoutes: 0,
    staleDataRejections: 0,
    twoLegEvaluated: 0,
    threeLegEvaluated: 0,
    intraDexEvaluated: 0,
    interDexEvaluated: 0,
    shadowQualifiedCount: 0,
    survivalCheckedCount: 0,
    survivalSurvivedCount: 0,
    survivalDecayedCount: 0,
    configuredRouteCount: 0,
    stateReadyRouteCount: 0,
    quoteValidRouteCount: 0,
    profitQualifiedRouteCount: 0,
    executionUnverifiedRouteCount: 0
  };

  // Live timestamped SOL/USDC price (null initially: zero fictitious default price permitted)
  private currentSolPriceUSDC: Decimal | null = null;
  private lastSolPriceTime = 0;

  constructor(
    config: AppConfig,
    customRpc?: SolanaRpcProvider,
    customWs?: SolanaWsProvider,
    customJupiter?: JupiterClient,
    customRepo?: ArbitrageRepository,
    customThresholdManager?: ProfitThresholdManager
  ) {
    this.config = config;
    this.rpc = customRpc || new SolanaRpcProvider(config);
    this.ws = customWs || new SolanaWsProvider(config);
    this.jupiter = customJupiter || new JupiterClient(config);
    this.poolRegistry = new PoolRegistry();
    this.stateCache = new StateCache();
    this.costModel = new CostModel(config);
    this.profitThresholdManager = customThresholdManager || new ProfitThresholdManager({
      filePath: config.PROFIT_THRESHOLD_FILE,
      initialThresholdUSDC: config.MIN_NET_PROFIT_USDC
    });
    this.calculator = new ArbitrageProfitCalculator(config, this.profitThresholdManager);
    this.repository = customRepo || new ArbitrageRepository(config);
    this.tradeSizer = new TradeSizer(config);

    // Initialize Competition-Aware Intelligence Components
    this.competitorAnalyzer = new CompetitorAnalyzer(this.rpc);
    this.competitionScorer = new CompetitionScorer();
    this.opportunityTracker = new OpportunityTracker();

    // Hook threshold changes to immediately reclassify active shadow opportunities
    this.profitThresholdManager.onThresholdChange((_newUSDC) => {
      const minHurdle = this.profitThresholdManager.getThresholdDecimal();
      this.opportunityTracker.reclassifyActiveOpportunities(minHurdle);
    });

    // Phase 1.4: Startup restart recovery from SQLite permanent repository
    try {
      const savedPools = this.repository.getAllVerifiedPools();
      if (savedPools.length > 0) {
        this.poolRegistry.loadPersistedPools(savedPools);
      }
    } catch (err) {
      this.repository.recordPersistenceError('loadPersistedPools', err);
    }

    // Load persisted discovered candidate pools into registry before building route index
    const discoveredFile = config.DISCOVERED_POOLS_FILE || './data/discovered_pools.json';
    const discovered = loadDiscoveredCandidates(discoveredFile);
    if (discovered.length > 0) {
      this.poolRegistry.loadDiscoveredCandidates(discovered);
    }

    // Initialize Route Index & Performance Pipelines
    this.routeIndex = new RouteIndex(this.poolRegistry.getAllPools());
    this.eventQueue = new BoundedEventQueue(config.MAX_EVENT_QUEUE_CAPACITY || 2000);
    this.latencyTracker = new LatencyTracker();

    // Phase 1.4 FIX 2: Wire pool verification changes to RouteIndex and SQLite persistence
    this.poolRegistry.onVerificationChange((poolId, status, blockerReason, lastVerifiedAt) => {
      this.routeIndex.updatePoolStatus(poolId, status, lastVerifiedAt);
      const poolConfig = this.poolRegistry.getPool(poolId);
      if (poolConfig) {
        try {
          this.repository.saveVerifiedPool({
            poolId: poolConfig.id,
            dex: poolConfig.dex,
            programId: poolConfig.programId,
            tokenAMint: poolConfig.tokenAMint,
            tokenBMint: poolConfig.tokenBMint,
            feeBps: poolConfig.feeBps,
            verificationStatus: poolConfig.verificationStatus || status,
            blockerReason: poolConfig.blockerReason || blockerReason,
            initialLiquidityUsd: poolConfig.initialLiquidityUsd || 0,
            accountLayoutSize: 0,
            lastVerifiedAt: poolConfig.lastVerifiedAt || 0,
            createdAt: Date.now()
          });
        } catch (err) {
          this.repository.recordPersistenceError('saveVerifiedPool', err);
        }
      }
    });

    // Phase 1.4: Reconcile saved permanent routes from SQLite repository
    try {
      const savedRoutes = this.repository.getAllRoutes();
      if (savedRoutes.length > 0) {
        this.routeIndex.reconcilePersistentRoutes(savedRoutes);
      }
    } catch (err) {
      this.repository.recordPersistenceError('reconcilePersistentRoutes', err);
    }

    // Phase 1.4: Sync verified pools and routes into persistent SQLite library
    this.syncRouteLibraryToStorage();

    // Setup WS disconnect/reconnect hooks
    this.ws.onDisconnect(() => {
      this.stateCache.invalidateAll('DISCONNECTED');
      const readyRoutes = this.routeIndex.getReadyRoutes();
      for (const r of readyRoutes) {
        this.routeIndex.setRouteStale(r.routeId, 'WS_DISCONNECTED');
        this.repository.updateRouteReadiness(r.routeId, false, 'WS_DISCONNECTED');
      }
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

    // 1. Establish real-time WebSocket connection
    await this.ws.connect();

    // 2. Fetch fresh live SOL price for non-fictitious fee conversion
    await this.refreshSolPrice();

    // 3. Initial snapshot hydration via RPC batch getMultipleAccountsAndContext
    await this.refreshAllPoolStates();

    // 3. Subscribe to real-time WebSocket updates for all pool accounts
    const pools = this.poolRegistry.getAllPools();
    for (const pool of pools) {
      this.ws.subscribeAccount(pool.id, (buf, slot, rxTime, monoTime) => {
        this.enqueueUpdate({
          type: 'POOL_ACCOUNT',
          key: pool.id,
          data: buf,
          slot,
          receivedAtMs: rxTime || Date.now(),
          monotonicReceiptTime: monoTime || performance.now()
        });
      });
    }

    // 4. High-frequency background drain loop
    const scanInterval = this.config.SCAN_INTERVAL_MS || 500;
    this.scanTimer = setInterval(async () => {
      if (!this.isRunning) return;

      // Update throughput telemetry
      const now = Date.now();
      const elapsed = (now - this.lastQuoteCountResetTime) / 1000;
      if (elapsed >= 1.0) {
        this.currentQuotesPerSec = Math.round(this.quotesProducedCount / elapsed);
        this.quotesProducedCount = 0;
        this.lastQuoteCountResetTime = now;
      }

      // Check event loop delay
      this.latencyTracker.measureEventLoopDelay();

      // Drain queued WebSocket account updates
      await this.drainEventQueue();

      // FIX 1: Expire READY routes when required live data, quote age, feed health, or slot limits become stale
      const expiredRoutes = this.routeIndex.expireStaleReadyRoutes(
        (id) => this.stateCache.getPoolState(id),
        this.config.MAX_QUOTE_AGE_MS || 2500,
        this.config.MAX_SLOT_GAP || 10,
        this.ws.getCurrentSlot()
      );
      for (const expired of expiredRoutes) {
        this.repository.updateRouteReadiness(expired.routeId, false, expired.verificationDetails);
      }
    }, scanInterval);
  }

  private enqueueUpdate(update: QueuedAccountUpdate): void {
    this.eventQueue.enqueue(update);
    if (!this.isDrainingQueue) {
      setImmediate(() => this.drainEventQueue());
    }
  }

  private async drainEventQueue(): Promise<void> {
    if (this.isDrainingQueue) return;
    this.isDrainingQueue = true;

    try {
      while (!this.eventQueue.isEmpty()) {
        const update = this.eventQueue.dequeue();
        if (!update) break;

        if (update.type === 'POOL_ACCOUNT') {
          this.processPoolAccountUpdate(update);
        } else if (update.type === 'VAULT_ACCOUNT') {
          this.processVaultAccountUpdate(update);
        } else if (update.type === 'OPENORDERS_ACCOUNT') {
          this.processOpenOrdersAccountUpdate(update);
        } else if (update.type === 'TICK_ARRAY_ACCOUNT') {
          this.processTickArrayAccountUpdate(update);
        }
      }
    } finally {
      this.isDrainingQueue = false;
    }
  }

  private processPoolAccountUpdate(update: QueuedAccountUpdate): void {
    const now = Date.now();
    if (!update.slot || update.slot <= 0 || !update.receivedAtMs || update.receivedAtMs > now + 5000) {
      return;
    }

    const poolConfig = this.poolRegistry.getPool(update.key);
    if (!poolConfig) return;

    const existing = this.stateCache.getPoolState(update.key);
    if (existing && existing.slot > update.slot) {
      // Reject out-of-order account updates
      return;
    }

    const adapter = dexRegistry.getAdapter(poolConfig.dex);
    if (!adapter) return;

    const decodeStart = performance.now();
    const decoded = adapter.decodePoolState(update.data, update.key, update.slot);
    const decodeDurationUs = (performance.now() - decodeStart) * 1000;
    this.latencyTracker.recordDecodeDuration(decodeDurationUs);

    if (decoded) {
      decoded.receivedAt = update.receivedAtMs;

      // Derive live SOL/USDC price from Orca Whirlpool sqrtPriceX64 (eliminates HTTP price requests)
      if (decoded.id === 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE' && decoded.extraData?.sqrtPrice) {
        try {
          const sqrtP = BigInt(String(decoded.extraData.sqrtPrice));
          const two64 = 18446744073709551616n;
          const ratio = Number(sqrtP) / Number(two64);
          const price = ratio * ratio * 1000; // 10^(9-6) = 1000
          if (price > 10 && price < 10000) {
            this.currentSolPriceUSDC = new Decimal(price);
            this.lastSolPriceTime = Date.now();
          }
        } catch {}
      }

      // Preserve existing hydrated state and verify dependency freshness
      const existing = this.stateCache.getPoolState(update.key);
      if (existing) {
        if (decoded.dex === 'ORCA_WHIRLPOOL' && existing.extraData && decoded.extraData) {
          if (decoded.reserveA === 0n && (existing.reserveA ?? 0n) > 0n) decoded.reserveA = existing.reserveA;
          if (decoded.reserveB === 0n && (existing.reserveB ?? 0n) > 0n) decoded.reserveB = existing.reserveB;
          const oldExtra = existing.extraData as any;
          const newExtra = decoded.extraData as any;
          if (oldExtra.tickArrays) {
            newExtra.tickArrays = oldExtra.tickArrays;
          }
          if (oldExtra.tickArraySlots) {
            newExtra.tickArraySlots = oldExtra.tickArraySlots;
          }
          if (oldExtra.tickArrayReceivedAt) {
            newExtra.tickArrayReceivedAt = oldExtra.tickArrayReceivedAt;
          }
        }

        if (decoded.dex === 'RAYDIUM_AMM' && existing.extraData && decoded.extraData) {
          const oldExtra = existing.extraData as any;
          const newExtra = decoded.extraData as any;

          // Check if critical account pointers changed (vaults, openOrders, market)
          const pointersChanged =
            !oldExtra.baseVault ||
            oldExtra.baseVault !== newExtra.baseVault ||
            oldExtra.quoteVault !== newExtra.quoteVault ||
            oldExtra.openOrders !== newExtra.openOrders ||
            oldExtra.marketId !== newExtra.marketId ||
            oldExtra.marketProgramId !== newExtra.marketProgramId;

          if (pointersChanged) {
            // Invalidate verification immediately if pool pointers changed.
            // Do NOT recycle old reserves or vault metadata!
            decoded.reserveA = 0n;
            decoded.reserveB = 0n;
            newExtra.openOrdersVerified = false;
            newExtra.unverifiedReason = 'ACCOUNT_POINTERS_CHANGED';
            this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'ACCOUNT_POINTERS_CHANGED');
            this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
          } else {
            // Account pointers are UNCHANGED.
            // Check vault observation metadata: Never substitute pool.receivedAt or pool.slot!
            const vASlot = oldExtra.vaultASlot;
            const vBSlot = oldExtra.vaultBSlot;
            const vAReceivedAt = oldExtra.vaultAReceivedAt;
            const vBReceivedAt = oldExtra.vaultBReceivedAt;

            const now = update.receivedAtMs || Date.now();
            const ttl = oldExtra.observationFreshnessTtlMs || this.config.OPENORDERS_OBSERVATION_TTL_MS || 30000;
            const hasReserves = (existing.reserveA ?? 0n) > 0n && (existing.reserveB ?? 0n) > 0n;
            const hasVaultMeta = !!(vASlot && vBSlot && vAReceivedAt && vBReceivedAt);
            const vAFresh = hasVaultMeta && (now - vAReceivedAt <= ttl);
            const vBFresh = hasVaultMeta && (now - vBReceivedAt <= ttl);
            const vaultSlotGap = hasVaultMeta ? Math.abs(vASlot - vBSlot) : Infinity;

            if (!hasReserves) {
              // Unhydrated reserves: fail closed, do not mark verified
              newExtra.openOrdersVerified = false;
              newExtra.unverifiedReason = 'VAULT_RESERVES_UNHYDRATED';
              this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'VAULT_RESERVES_UNHYDRATED');
              this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
            } else if (!hasVaultMeta) {
              // Missing vault timestamps or slots: fail closed, do not silently recycle old reserves
              newExtra.openOrdersVerified = false;
              newExtra.unverifiedReason = 'MISSING_VAULT_METADATA';
              this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'MISSING_VAULT_METADATA');
              this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
            } else if (!vAFresh || !vBFresh) {
              // Stale vault observation: fail closed
              newExtra.openOrdersVerified = false;
              newExtra.unverifiedReason = 'STALE_VAULT_SNAPSHOT';
              this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'STALE_VAULT_SNAPSHOT');
              this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
            } else if (vaultSlotGap > 100) {
              // Mismatched vault slots: fail closed
              newExtra.openOrdersVerified = false;
              newExtra.unverifiedReason = 'INCONSISTENT_VAULT_SNAPSHOT';
              this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'INCONSISTENT_VAULT_SNAPSHOT');
              this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
            } else {
              // Vault data is fresh and validated! Preserve reserves and metadata
              if (decoded.reserveA === 0n) decoded.reserveA = existing.reserveA;
              if (decoded.reserveB === 0n) decoded.reserveB = existing.reserveB;
              newExtra.vaultASlot = vASlot;
              newExtra.vaultBSlot = vBSlot;
              newExtra.vaultAReceivedAt = vAReceivedAt;
              newExtra.vaultBReceivedAt = vBReceivedAt;

              // Now verify OpenOrders status
              if (oldExtra.openOrdersVerified === true && !oldExtra.unverifiedReason) {
                const lastConfirmedAt = oldExtra.lastConfirmedAt || oldExtra.verifiedAt || 0;
                const isOoFresh = (now - lastConfirmedAt) <= ttl;
                const wsHealthy = this.ws.getHealth() !== 'DISCONNECTED';

                if (!wsHealthy) {
                  newExtra.openOrdersVerified = false;
                  newExtra.unverifiedReason = 'SUBSCRIPTION_LOSS';
                  this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'SUBSCRIPTION_LOSS');
                  this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
                } else if (!isOoFresh) {
                  newExtra.openOrdersVerified = false;
                  newExtra.unverifiedReason = 'OBSERVATION_EXPIRED';
                  this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', 'OBSERVATION_EXPIRED');
                  this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
                  this.triggerRateLimitedReconfirmation(update.key);
                } else {
                  // Both vaults and OpenOrders are verified and fresh!
                  newExtra.openOrdersVerified = true;
                  newExtra.openOrdersBaseTokenTotal = oldExtra.openOrdersBaseTokenTotal;
                  newExtra.openOrdersQuoteTokenTotal = oldExtra.openOrdersQuoteTokenTotal;
                  newExtra.lastAccountChangeSlot = oldExtra.lastAccountChangeSlot || oldExtra.openOrdersSlot || existing.slot;
                  newExtra.lastRpcConfirmationContextSlot = oldExtra.lastRpcConfirmationContextSlot || oldExtra.verifiedSlot || existing.slot;
                  newExtra.lastConfirmedAt = lastConfirmedAt;
                  newExtra.observationFreshnessTtlMs = ttl;
                  newExtra.openOrdersSlot = oldExtra.openOrdersSlot;
                  newExtra.verifiedSlot = update.slot;
                  newExtra.verifiedAt = oldExtra.verifiedAt;
                  delete newExtra.unverifiedReason;

                  this.poolRegistry.updatePoolVerification(update.key, 'VERIFIED_DIRECT');
                  this.routeIndex.updatePoolStatus(update.key, 'VERIFIED_DIRECT');
                }
              } else {
                newExtra.openOrdersVerified = false;
                newExtra.unverifiedReason = oldExtra.unverifiedReason || 'UNVERIFIED';
                this.poolRegistry.updatePoolVerification(update.key, 'QUOTE_UNVERIFIED', newExtra.unverifiedReason);
                this.routeIndex.updatePoolStatus(update.key, 'QUOTE_UNVERIFIED');
              }
            }
          }
        }
      }

      const { hasChanged } = this.stateCache.setPoolState(decoded);

      // Reevaluate only routes affected by this pool update if quote-relevant state changed
      if (hasChanged && (decoded.dex !== 'RAYDIUM_AMM' || ((decoded.reserveA ?? 0n) > 0n && (decoded.reserveB ?? 0n) > 0n))) {
        this.evaluateAffectedRoutes(update.key, update.monotonicReceiptTime);
      }
    }
  }

  private processOpenOrdersAccountUpdate(update: QueuedAccountUpdate): void {
    const poolId = this.openOrdersToPool.get(update.key);
    if (!poolId) return;

    const pool = this.stateCache.getPoolState(poolId);
    if (!pool || pool.dex !== 'RAYDIUM_AMM' || !pool.extraData) return;

    const extra = pool.extraData as any;
    if (extra.openOrdersSlot && update.slot < extra.openOrdersSlot) {
      // Reject out-of-order open orders updates
      return;
    }
    if (update.data.length < 3228) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'OPENORDERS_LAYOUT_INVALID';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_LAYOUT_INVALID');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }

    const market = new PublicKey(update.data.subarray(13, 45)).toBase58();
    const authority = new PublicKey(update.data.subarray(45, 77)).toBase58();

    if (market !== extra.marketId) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'OPENORDERS_MARKET_MISMATCH';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_MARKET_MISMATCH');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }

    const expectedAuthority = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
    if (authority !== expectedAuthority) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'OPENORDERS_AUTHORITY_MISMATCH';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_AUTHORITY_MISMATCH');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }

    // Reject out-of-order notifications
    if (extra.lastAccountChangeSlot && update.slot < extra.lastAccountChangeSlot) {
      return;
    }

    const baseTokenTotal = update.data.readBigUInt64LE(85);
    const quoteTokenTotal = update.data.readBigUInt64LE(101);

    // Validate ALL required vault dependencies before promoting to VERIFIED_DIRECT
    const now = update.receivedAtMs || Date.now();
    const ttl = extra.observationFreshnessTtlMs || this.config.OPENORDERS_OBSERVATION_TTL_MS || 30000;
    const hasReserves = (pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n;
    const vASlot = extra.vaultASlot;
    const vBSlot = extra.vaultBSlot;
    const vAReceivedAt = extra.vaultAReceivedAt;
    const vBReceivedAt = extra.vaultBReceivedAt;
    const hasVaultMeta = !!(vASlot && vBSlot && vAReceivedAt && vBReceivedAt);
    const vAFresh = hasVaultMeta && (now - vAReceivedAt <= ttl);
    const vBFresh = hasVaultMeta && (now - vBReceivedAt <= ttl);
    const vaultSlotGap = hasVaultMeta ? Math.abs(vASlot - vBSlot) : Infinity;

    if (!hasReserves) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'VAULT_RESERVES_UNHYDRATED';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'VAULT_RESERVES_UNHYDRATED');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }
    if (!hasVaultMeta) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'MISSING_VAULT_METADATA';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'MISSING_VAULT_METADATA');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }
    if (!vAFresh || !vBFresh) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'STALE_VAULT_SNAPSHOT';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'STALE_VAULT_SNAPSHOT');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }
    if (vaultSlotGap > 100) {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'INCONSISTENT_VAULT_SNAPSHOT';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'INCONSISTENT_VAULT_SNAPSHOT');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      return;
    }

    extra.openOrdersVerified = true;
    extra.openOrdersBaseTokenTotal = baseTokenTotal.toString();
    extra.openOrdersQuoteTokenTotal = quoteTokenTotal.toString();
    extra.lastAccountChangeSlot = update.slot;
    extra.lastRpcConfirmationContextSlot = update.slot;
    extra.lastConfirmedAt = now;
    extra.observationFreshnessTtlMs = ttl;
    extra.openOrdersSlot = update.slot;
    extra.verifiedSlot = update.slot;
    extra.verifiedAt = now;
    delete extra.unverifiedReason;

    this.poolRegistry.updatePoolVerification(poolId, 'VERIFIED_DIRECT');
    this.routeIndex.updatePoolStatus(poolId, 'VERIFIED_DIRECT');

    this.evaluateAffectedRoutes(poolId, update.monotonicReceiptTime);
  }

  private processVaultAccountUpdate(update: QueuedAccountUpdate): void {
    if (update.data.length >= 72) {
      try {
        const rawAmount = update.data.readBigUInt64LE(64);
        const mapping = this.vaultToPool.get(update.key);
        if (mapping) {
          const pool = this.stateCache.getPoolState(mapping.poolId);
          if (pool) {
            const extra = (pool.extraData || {}) as any;
            const currentVaultSlot = mapping.isA ? (extra.vaultASlot || 0) : (extra.vaultBSlot || 0);
            if (update.slot < currentVaultSlot) {
              // Reject out-of-order vault updates
              return;
            }
            if (mapping.isA) {
              pool.reserveA = rawAmount;
              extra.vaultASlot = update.slot;
              extra.vaultAReceivedAt = update.receivedAtMs;
            } else {
              pool.reserveB = rawAmount;
              extra.vaultBSlot = update.slot;
              extra.vaultBReceivedAt = update.receivedAtMs;
            }
            pool.slot = update.slot;
            pool.receivedAt = update.receivedAtMs;

            // Runtime recovery: If valid fresh vault data arrives, check if pool can be promoted back to VERIFIED_DIRECT
            if (pool.dex === 'RAYDIUM_AMM') {
              const now = update.receivedAtMs || Date.now();
              const ttl = extra.observationFreshnessTtlMs || this.config.OPENORDERS_OBSERVATION_TTL_MS || 30000;
              const hasReserves = (pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n;
              const vASlot = extra.vaultASlot;
              const vBSlot = extra.vaultBSlot;
              const vAReceivedAt = extra.vaultAReceivedAt;
              const vBReceivedAt = extra.vaultBReceivedAt;
              const hasVaultMeta = !!(vASlot && vBSlot && vAReceivedAt && vBReceivedAt);
              const vAFresh = hasVaultMeta && (now - vAReceivedAt <= ttl);
              const vBFresh = hasVaultMeta && (now - vBReceivedAt <= ttl);
              const vaultSlotGap = hasVaultMeta ? Math.abs(vASlot - vBSlot) : Infinity;

              if (hasReserves && vAFresh && vBFresh && vaultSlotGap <= 100 && extra.openOrdersVerified === true) {
                const lastConfirmedAt = extra.lastConfirmedAt || extra.verifiedAt || 0;
                const isOoFresh = (now - lastConfirmedAt) <= ttl;
                if (isOoFresh) {
                  delete extra.unverifiedReason;
                  this.poolRegistry.updatePoolVerification(mapping.poolId, 'VERIFIED_DIRECT');
                  this.routeIndex.updatePoolStatus(mapping.poolId, 'VERIFIED_DIRECT');
                }
              }
            }

            const { hasChanged } = this.stateCache.setPoolState(pool);

            // Reevaluate only routes affected by this vault update if state changed
            if (hasChanged && (pool.dex !== 'RAYDIUM_AMM' || ((pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n))) {
              this.evaluateAffectedRoutes(mapping.poolId, update.monotonicReceiptTime);
            }
          }
        }
      } catch {}
    }
  }

  private processTickArrayAccountUpdate(update: QueuedAccountUpdate): void {
    const now = Date.now();
    if (!update.slot || update.slot <= 0 || !update.receivedAtMs || update.receivedAtMs > now + 5000) {
      return;
    }

    const mapping = this.tickArrayToPool.get(update.key);
    if (!mapping) return;

    const pool = this.stateCache.getPoolState(mapping.poolId);
    if (!pool || pool.dex !== 'ORCA_WHIRLPOOL') return;

    const extra = (pool.extraData || {}) as any;
    const currentArraySlot = extra.tickArraySlots?.[mapping.startTickIndex] || 0;
    if (update.slot < currentArraySlot) {
      // Reject out-of-order account updates
      return;
    }

    const decoded = decodeTickArrayAccount(update.data, mapping.poolId);
    if (!decoded) return;

    if (!extra.tickArrays) extra.tickArrays = {};
    if (!extra.tickArraySlots) extra.tickArraySlots = {};
    if (!extra.tickArrayReceivedAt) extra.tickArrayReceivedAt = {};

    extra.tickArrays[mapping.startTickIndex] = decoded;
    extra.tickArraySlots[mapping.startTickIndex] = update.slot;
    extra.tickArrayReceivedAt[mapping.startTickIndex] = update.receivedAtMs;

    // Independent Freshness: Do NOT overwrite pool.slot or pool.receivedAt with tick array update!
    // The Whirlpool's observation timestamp and slot represent the pool state itself.

    // Safe Promotion: Check if Orca Whirlpool now has all required surrounding tick arrays hydrated and fresh
    const tickSpacing = extra.tickSpacing || 1;
    const tickCurrent = extra.tickCurrent;
    const liquidity = BigInt(extra?.liquidity || '0');
    if (tickCurrent !== undefined && extra.tickArrays && liquidity > 0n) {
      const surroundingStarts = getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);
      const arrayTimestamps = extra.tickArrayReceivedAt || {};
      const arraySlots = extra.tickArraySlots || {};
      const ttl = 30000;

      const allSurroundingPresent = surroundingStarts.every(idx => {
        const arr = extra.tickArrays[idx];
        const t = arrayTimestamps[idx];
        const s = arraySlots[idx];
        return arr && t && (now - t <= ttl) && s && Math.abs(pool.slot - s) <= 100;
      });

      if (allSurroundingPresent) {
        delete extra.unverifiedReason;
        this.poolRegistry.updatePoolVerification(mapping.poolId, 'VERIFIED_DIRECT');
        this.routeIndex.updatePoolStatus(mapping.poolId, 'VERIFIED_DIRECT');
      }
    }

    const { hasChanged } = this.stateCache.setPoolState(pool);
    if (hasChanged) {
      this.evaluateAffectedRoutes(mapping.poolId, update.monotonicReceiptTime);
    }
  }

  private lastReconfirmationTime = new Map<string, number>();

  public async reconfirmOpenOrders(poolId: string): Promise<boolean> {
    const pool = this.stateCache.getPoolState(poolId);
    if (!pool || pool.dex !== 'RAYDIUM_AMM' || !pool.extraData) return false;

    const extra = pool.extraData as any;
    if (!extra.openOrders) return false;

    const now = Date.now();
    const lastAttempt = this.lastReconfirmationTime.get(poolId) || 0;
    if (now - lastAttempt < 5000) return false;
    this.lastReconfirmationTime.set(poolId, now);

    this.auditMetrics.raydiumReconfirmationAttempts = (this.auditMetrics.raydiumReconfirmationAttempts || 0) + 1;

    try {
      const ooPubkey = new PublicKey(extra.openOrders);
      const ooRes = await this.rpc.getMultipleAccountsAndContext([ooPubkey]);
      const ooSlot = ooRes.slot;
      const acc = ooRes.value[0];

      if (!acc || !acc.data || acc.data.length < 3228) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'OPENORDERS_LAYOUT_INVALID';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_LAYOUT_INVALID');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      const expectedOwner = extra.marketProgramId || 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX';
      const ownerStr = acc.owner ? acc.owner.toBase58() : '';
      if (ownerStr !== expectedOwner && ownerStr !== 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX') {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'OPENORDERS_OWNER_MISMATCH';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_OWNER_MISMATCH');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      const market = new PublicKey(acc.data.subarray(13, 45)).toBase58();
      const authority = new PublicKey(acc.data.subarray(45, 77)).toBase58();
      const expectedAuthority = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

      if (market !== extra.marketId) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'OPENORDERS_MARKET_MISMATCH';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_MARKET_MISMATCH');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      if (authority !== expectedAuthority) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'OPENORDERS_AUTHORITY_MISMATCH';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OPENORDERS_AUTHORITY_MISMATCH');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      const baseTokenTotal = acc.data.readBigUInt64LE(85);
      const quoteTokenTotal = acc.data.readBigUInt64LE(101);

      // CRITICAL DEPENDENCY INTEGRITY CHECK:
      // Validate ALL required vault dependencies FIRST before promoting openOrdersVerified to true.
      // 1. Check vault hydration:
      const reservesHydrated = (pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n;
      if (!reservesHydrated) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'VAULT_RESERVES_UNHYDRATED';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'VAULT_RESERVES_UNHYDRATED');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      // 2. Check vault observation timestamps and slots:
      // Never substitute pool.receivedAt or pool.slot for missing vault freshness evidence.
      const vASlot = extra.vaultASlot;
      const vBSlot = extra.vaultBSlot;
      const vAConfirmedAt = extra.vaultAReceivedAt;
      const vBConfirmedAt = extra.vaultBReceivedAt;

      if (!vAConfirmedAt || !vBConfirmedAt || !vASlot || !vBSlot) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'MISSING_VAULT_METADATA';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'MISSING_VAULT_METADATA');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      // 3. Check vault freshness and slot gap:
      const nowAfter = Date.now();
      const vaultTtl = this.config.OPENORDERS_OBSERVATION_TTL_MS || 30000;
      const vaultsFresh = (nowAfter - vAConfirmedAt <= vaultTtl) && (nowAfter - vBConfirmedAt <= vaultTtl);
      const vaultSlotGap = Math.abs(vASlot - vBSlot);

      if (!vaultsFresh) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'STALE_VAULT_SNAPSHOT';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'STALE_VAULT_SNAPSHOT');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      if (vaultSlotGap > 100) {
        extra.openOrdersVerified = false;
        extra.unverifiedReason = 'STALE_VAULT_SNAPSHOT';
        this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'STALE_VAULT_SNAPSHOT');
        this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
        this.stateCache.setPoolState(pool);
        return false;
      }

      // ONLY AFTER EVERY SINGLE DEPENDENCY PASSES: promote VERIFIED_DIRECT
      extra.openOrdersVerified = true;
      extra.openOrdersBaseTokenTotal = baseTokenTotal.toString();
      extra.openOrdersQuoteTokenTotal = quoteTokenTotal.toString();
      extra.lastAccountChangeSlot = ooSlot;
      extra.lastRpcConfirmationContextSlot = ooSlot;
      extra.lastConfirmedAt = nowAfter;
      extra.observationFreshnessTtlMs = vaultTtl;
      extra.openOrdersSlot = ooSlot;
      extra.verifiedSlot = ooSlot;
      extra.verifiedAt = nowAfter;
      delete extra.unverifiedReason;

      this.poolRegistry.updatePoolVerification(poolId, 'VERIFIED_DIRECT');
      this.routeIndex.updatePoolStatus(poolId, 'VERIFIED_DIRECT');
      this.stateCache.setPoolState(pool);
      this.auditMetrics.raydiumReconfirmationSuccesses = (this.auditMetrics.raydiumReconfirmationSuccesses || 0) + 1;

      this.evaluateAffectedRoutes(poolId);
      return true;
    } catch {
      extra.openOrdersVerified = false;
      extra.unverifiedReason = 'RPC_TIMEOUT';
      this.poolRegistry.updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'RPC_TIMEOUT');
      this.routeIndex.updatePoolStatus(poolId, 'QUOTE_UNVERIFIED');
      this.stateCache.setPoolState(pool);
      return false;
    }
  }

  private triggerRateLimitedReconfirmation(poolId: string): void {
    const now = Date.now();
    const last = this.lastReconfirmationTime.get(poolId) || 0;
    if (now - last >= 5000) {
      setImmediate(() => {
        this.reconfirmOpenOrders(poolId).catch(() => {});
      });
    }
  }

  private computePoolFingerprint(pool: PoolState): string {
    const extra = (pool.extraData || {}) as any;
    const rev = pool.stateRevision || 1;
    if (pool.dex === 'ORCA_WHIRLPOOL') {
      let taSummary = 'none';
      if (extra.tickArrays) {
        const entries: [number, any][] = [];
        if (extra.tickArrays instanceof Map) {
          for (const [k, v] of extra.tickArrays.entries()) {
            entries.push([Number(k), v]);
          }
        } else {
          for (const [k, v] of Object.entries(extra.tickArrays)) {
            entries.push([Number(k), v]);
          }
        }
        entries.sort((a, b) => a[0] - b[0]);
        taSummary = entries.map(([startIdx, arr]) => `${startIdx}:${getTickArrayContentSignature(arr)}`).join(';');
      }
      const feeRate = extra.feeRate ?? extra.feeRateRaw ?? ((pool.feeBps || 0) * 100);
      return `${pool.id}@s${pool.slot}:rev${rev}:fr${feeRate}:ts${extra.tickSpacing || 0}:p${extra.sqrtPrice || 0}:t${extra.tickCurrent || 0}:L${extra.liquidity || 0}:ta${taSummary}`;
    }
    if (pool.dex === 'RAYDIUM_AMM') {
      const sfn = extra.swapFeeNumerator ?? '25';
      const sfd = extra.swapFeeDenominator ?? '10000';
      const pnlA = extra.baseNeedTakePnl ?? '0';
      const pnlB = extra.quoteNeedTakePnl ?? '0';
      return `${pool.id}@s${pool.slot}:rev${rev}:rA${pool.reserveA || 0}:rB${pool.reserveB || 0}:sfn${sfn}:sfd${sfd}:pnlA${pnlA}:pnlB${pnlB}:ooB${extra.openOrdersBaseTokenTotal || 0}:ooQ${extra.openOrdersQuoteTokenTotal || 0}:ooSlot${extra.openOrdersSlot || 0}:vA${extra.vaultASlot || 0}:vB${extra.vaultBSlot || 0}`;
    }
    return `${pool.id}@s${pool.slot}:rev${rev}:rA${pool.reserveA || 0}:rB${pool.reserveB || 0}`;
  }

  private evaluateAffectedRoutes(poolId: string, monotonicReceiptTime?: number): void {
    const affectedRoutes = this.routeIndex.getRoutesAffectedByPool(poolId);
    for (const route of affectedRoutes) {
      this.evaluateIndexedRoute(route, monotonicReceiptTime);
    }
  }

  private evaluateIndexedRoute(route: IndexedDirectedRoute, monotonicReceiptTime?: number): void {
    this.auditMetrics.configuredRouteCount = this.routeIndex.getAllRoutes().length;

    // 1. TOTAL ATTEMPTS EVALUATED: Every candidate route evaluation entering the pipeline
    this.auditMetrics.totalEvaluated++;
    if (route.cycleType === '3_LEG') {
      this.auditMetrics.threeLegEvaluated = (this.auditMetrics.threeLegEvaluated || 0) + 1;
    } else {
      this.auditMetrics.twoLegEvaluated = (this.auditMetrics.twoLegEvaluated || 0) + 1;
    }
    if (route.isIntraDex) {
      this.auditMetrics.intraDexEvaluated = (this.auditMetrics.intraDexEvaluated || 0) + 1;
    } else {
      this.auditMetrics.interDexEvaluated = (this.auditMetrics.interDexEvaluated || 0) + 1;
    }

    const quoterLegs: QuoterLeg[] = [];
    let oldestSlot = Infinity;

    for (let idx = 0; idx < route.legs.length; idx++) {
      const legDef = route.legs[idx];

      // Exclude unsupported venues
      if (!this.poolRegistry.isVenueSupported(legDef.dex)) {
        this.rejectedCount++;
        this.auditMetrics.rejectedRoutes++;
        this.auditMetrics.unsupportedRoutes = (this.auditMetrics.unsupportedRoutes || 0) + 1;
        this.rejectionBreakdown['UNSUPPORTED_ROUTE'] = (this.rejectionBreakdown['UNSUPPORTED_ROUTE'] || 0) + 1;
        return;
      }

      // Require runtime pool verification before accepting a route as state-ready and quote-valid
      const poolConfig = this.poolRegistry.getPool(legDef.poolId);
      if (!poolConfig || poolConfig.verificationStatus !== 'VERIFIED_DIRECT') {
        this.rejectedCount++;
        this.auditMetrics.rejectedRoutes++;
        const reason = (poolConfig?.blockerReason || 'QUOTE_UNVERIFIED') as RejectionReasonCode;
        this.rejectionBreakdown[reason] = (this.rejectionBreakdown[reason] || 0) + 1;
        this.auditMetrics.quoteValidationFailures++;
        return;
      }

      const pool = this.stateCache.getPoolState(legDef.poolId);
      if (!pool) {
        this.rejectedCount++;
        this.auditMetrics.rejectedRoutes++;
        return;
      }

      // Fail closed if Raydium AMM dependencies are unverified, stale or unhydrated
      if (pool.dex === 'RAYDIUM_AMM') {
        const extra = pool.extraData as any;
        if (extra?.openOrdersVerified !== true || extra?.unverifiedReason) {
          this.rejectedCount++;
          this.auditMetrics.rejectedRoutes++;
          const reason = (extra?.unverifiedReason || 'QUOTE_UNVERIFIED') as RejectionReasonCode;
          this.rejectionBreakdown[reason] = (this.rejectionBreakdown[reason] || 0) + 1;
          this.auditMetrics.quoteValidationFailures++;
          return;
        }
        if ((pool.reserveA ?? 0n) <= 0n || (pool.reserveB ?? 0n) <= 0n) {
          this.rejectedCount++;
          this.auditMetrics.rejectedRoutes++;
          this.rejectionBreakdown['INSUFFICIENT_LIQUIDITY'] = (this.rejectionBreakdown['INSUFFICIENT_LIQUIDITY'] || 0) + 1;
          return;
        }
      }

      // Fail closed if Orca Whirlpool dependencies are unhydrated, missing tick arrays, or stale
      if (pool.dex === 'ORCA_WHIRLPOOL') {
        const extra = pool.extraData as any;
        const tickSpacing = extra?.tickSpacing || 1;
        const tickCurrent = extra?.tickCurrent;
        if (tickCurrent === undefined || !extra?.sqrtPrice) {
          this.rejectedCount++;
          this.auditMetrics.rejectedRoutes++;
          this.rejectionBreakdown['MISSING_TICK_DATA'] = (this.rejectionBreakdown['MISSING_TICK_DATA'] || 0) + 1;
          this.auditMetrics.quoteValidationFailures++;
          return;
        }

        const direction = legDef.inputMint === pool.tokenAMint ? 'A_TO_B' : 'B_TO_A';
        const requiredStarts = getRequiredTickArrayStartIndices(tickCurrent, tickSpacing, direction);
        const tickArrays = extra?.tickArrays;
        if (!tickArrays || !extra?.tickArrayReceivedAt || !extra?.tickArraySlots) {
          this.rejectedCount++;
          this.auditMetrics.rejectedRoutes++;
          this.rejectionBreakdown['MISSING_TICK_DATA'] = (this.rejectionBreakdown['MISSING_TICK_DATA'] || 0) + 1;
          this.auditMetrics.quoteValidationFailures++;
          return;
        }

        const now = Date.now();
        const ttl = extra?.observationFreshnessTtlMs || this.config.OPENORDERS_OBSERVATION_TTL_MS || 30000;
        let failCode: RejectionReasonCode | null = null;

        for (const startIdx of requiredStarts) {
          const arr = tickArrays instanceof Map ? tickArrays.get(startIdx) : tickArrays[startIdx];
          if (!arr) {
            failCode = 'MISSING_TICK_DATA';
            break;
          }
          const t = extra.tickArrayReceivedAt?.[startIdx];
          const s = extra.tickArraySlots?.[startIdx];
          if (!t || t <= 0 || !s || s <= 0) {
            failCode = 'MISSING_TICK_DATA';
            break;
          }
          if (t > now + 5000 || now - t > ttl) {
            failCode = 'STALE_QUOTE';
            break;
          }
          if (pool.slot && Math.abs(pool.slot - s) > this.config.MAX_SLOT_GAP) {
            failCode = 'SLOT_MISMATCH';
            break;
          }
        }

        if (failCode) {
          this.rejectedCount++;
          this.auditMetrics.rejectedRoutes++;
          this.rejectionBreakdown[failCode] = (this.rejectionBreakdown[failCode] || 0) + 1;
          this.auditMetrics.quoteValidationFailures++;
          this.routeIndex.setRouteStale(route.routeId, failCode);
          this.repository.updateRouteReadiness(route.routeId, false, failCode);
          return;
        }
      }

      const adapter = dexRegistry.getAdapter(legDef.dex);
      if (!adapter) {
        this.rejectedCount++;
        this.auditMetrics.rejectedRoutes++;
        return;
      }

      let slippageBps = this.config.SLIPPAGE_BPS_LEG1;
      if (idx === 1) slippageBps = this.config.SLIPPAGE_BPS_LEG2;
      else if (idx === 2) slippageBps = this.config.SLIPPAGE_BPS_LEG3 || 10;

      quoterLegs.push({
        pool,
        adapter,
        inputMint: legDef.inputMint,
        outputMint: legDef.outputMint,
        slippageBps
      });

      if (pool.slot < oldestSlot) oldestSlot = pool.slot;
    }

    if (quoterLegs.length < route.legs.length) {
      this.rejectedCount++;
      this.auditMetrics.rejectedRoutes++;
      return;
    }

    const currentSlot = this.ws.getCurrentSlot();
    const wsConnected = this.ws.getHealth() !== 'DISCONNECTED';

    // Fail closed: Require fresh, live, non-fictitious SOL/USDC price for fee conversions
    if (!this.currentSolPriceUSDC || this.lastSolPriceTime <= 0) {
      this.rejectedCount++;
      this.auditMetrics.rejectedRoutes++;
      return;
    }

    // Calculate current execution costs
    const costResult = this.costModel.calculateCosts({
      solPriceUSDC: this.currentSolPriceUSDC,
      solPriceTimestamp: this.lastSolPriceTime,
      requiresAtaSetup: route.legs.some(l => l.inputMint === CANONICAL_WSOL_MINT || l.outputMint === CANONICAL_WSOL_MINT)
    });

    if (!costResult.isComplete || !costResult.breakdown) {
      this.rejectedCount++;
      this.auditMetrics.rejectedRoutes++;
      return;
    }

    // 2. STATE-READY STAGE: All pool dependencies are verified, hydrated, compatible, and cost breakdown is complete
    this.auditMetrics.stateReadyRouteCount = (this.auditMetrics.stateReadyRouteCount || 0) + 1;

    // Deterministic state fingerprint uniquely identifies verified account revisions and state snapshots
    const stateVersion = quoterLegs.map(l => this.computePoolFingerprint(l.pool)).join('|');

    // Fast optimal trade sizing
    const quoteStart = performance.now();
    const sizerResult = this.tradeSizer.findOptimalSize(quoterLegs, costResult.breakdown, currentSlot);
    const quoteDurationUs = (performance.now() - quoteStart) * 1000;
    this.latencyTracker.recordQuoteDuration(quoteDurationUs);

    this.quotesProducedCount += sizerResult.evaluatedSizesCount * route.legs.length;

    // Both expected quotes and conservative quotes MUST complete every route leg
    if (
      sizerResult.optimalQuotes.length < route.legs.length ||
      sizerResult.conservativeQuotes.length < route.legs.length
    ) {
      this.rejectedCount++;
      this.auditMetrics.rejectedRoutes++;
      const reason = (sizerResult.allEvaluations[0]?.rejectionReason || 'INSUFFICIENT_LIQUIDITY') as RejectionReasonCode;
      this.rejectionBreakdown[reason] = (this.rejectionBreakdown[reason] || 0) + 1;
      if (reason === 'QUOTE_UNVERIFIED' || reason === 'MISSING_TICK_DATA' || reason === 'TICK_BOUNDARY_EXCEEDED') {
        this.auditMetrics.quoteValidationFailures++;
      }
      if (reason === 'UNSUPPORTED_ROUTE') {
        this.auditMetrics.unsupportedRoutes = (this.auditMetrics.unsupportedRoutes || 0) + 1;
      }
      return;
    }

    // 3. QUOTE-VALID STAGE: Exact quotes successfully produced for all legs on both expected and conservative paths
    this.auditMetrics.quoteValidRouteCount = (this.auditMetrics.quoteValidRouteCount || 0) + 1;

    const validationStart = performance.now();
    const candidate = this.calculator.evaluateCandidate({
      initialAmountUSDC: BigInt(Math.floor(sizerResult.optimalSizeUSDC * 1e6)),
      leg1Quote: sizerResult.optimalQuotes[0],
      leg2Quote: sizerResult.optimalQuotes[1],
      leg3Quote: sizerResult.optimalQuotes[2],
      leg1ConservativeQuote: sizerResult.conservativeQuotes[0],
      leg2ConservativeQuote: sizerResult.conservativeQuotes[1],
      leg3ConservativeQuote: sizerResult.conservativeQuotes[2],
      cycleType: route.cycleType,
      optimalSizeUSDC: sizerResult.optimalSizeUSDC,
      sizingMethod: sizerResult.sizingMethod,
      costs: costResult.breakdown,
      currentSlot,
      wsConnected,
      solPriceTimestamp: this.lastSolPriceTime,
      topAlternatives: sizerResult.topAlternatives,
      stateVersion
    });

    // Phase 1.4: Update route readiness in permanent library index & persistent repository (non-blocking)
    if (candidate.rejectionReasons.includes('STALE_QUOTE') || candidate.rejectionReasons.includes('SLOT_MISMATCH')) {
      const reason = candidate.rejectionReasons.join(', ');
      this.routeIndex.setRouteStale(route.routeId, reason);
      this.repository.updateRouteReadiness(route.routeId, false, reason);
    } else {
      const isReady = this.routeIndex.setRouteReady(route.routeId, {
        expectedNetUSDC: candidate.expectedNetUSDC,
        timestamp: candidate.timestamp
      });
      if (isReady) {
        this.repository.updateRouteReadiness(route.routeId, true, undefined, {
          expectedNetUSDC: candidate.expectedNetUSDC,
          timestamp: candidate.timestamp
        });
      }
    }

    // Simulated Capital Management: Bound total simultaneous active reservations against VIRTUAL_CAPITAL_USDC
    if (candidate.status === 'QUALIFIED_SHADOW') {
      this.opportunityTracker.purgeStaleOpportunities(10000);
      const activeAllocated = this.opportunityTracker.getActiveAllocatedCapital();
      const oppSizeUSDC = candidate.optimalSizeUSDC || Number(candidate.inputAmountUSDC) / 1e6;
      const oppKey = `${quoterLegs.map(l => l.pool.id).join('->')}:${oppSizeUSDC.toFixed(0)}`;
      const existingOpp = this.opportunityTracker.getActiveOpportunity(oppKey);
      if (!existingOpp && (activeAllocated + oppSizeUSDC > this.config.VIRTUAL_CAPITAL_USDC)) {
        candidate.status = 'REJECTED';
        candidate.rejectionReasons.push('SIMULATED_CAPITAL_EXHAUSTED');
      }
    }

    // Competition-Aware Opportunity Scoring (Section 4)
    const poolMetrics = route.legs.map(l => this.competitorAnalyzer.getCachedMetrics(l.poolId));
    const scoreResult = this.competitionScorer.scoreCandidate(candidate, poolMetrics);
    candidate.competitionScore = scoreResult.score;
    candidate.executionProbability = scoreResult.executionProbability;
    candidate.scoringBreakdown = scoreResult.breakdown;

    const validationDurationUs = (performance.now() - validationStart) * 1000;
    this.latencyTracker.recordValidationDuration(validationDurationUs);

    // Total detection-to-decision latency
    if (monotonicReceiptTime) {
      const decisionDurationUs = (performance.now() - monotonicReceiptTime) * 1000;
      this.latencyTracker.recordDecisionDuration(decisionDurationUs);
    }

    if (oldestSlot !== Infinity) {
      this.latencyTracker.recordSlotLag(Math.max(0, currentSlot - oldestSlot));
    }

    // Track gross profitability
    if (parseFloat(candidate.expectedNetUSDC) > 0) {
      this.auditMetrics.candidatesGrossPositive++;
    }

    // Deduplicate identical repeated opportunities using route + stateVersion + size
    const isDupe = this.stateCache.isDuplicate({
      route: route.routeId,
      amountUSDC: candidate.inputAmountUSDC,
      netProfitUSDC: candidate.minConservativeNetUSDC,
      stateVersion
    });

    if (!isDupe) {
      this.auditMetrics.uniqueOpportunities++;
    }

    if (candidate.status === 'QUALIFIED_SHADOW') {
      this.qualifiedCount++;
      this.auditMetrics.candidatesConservativeQualified++;
      this.auditMetrics.shadowQualifiedCount = (this.auditMetrics.shadowQualifiedCount || 0) + 1;
      this.auditMetrics.profitQualifiedRouteCount = (this.auditMetrics.profitQualifiedRouteCount || 0) + 1;
      candidate.executionStatus = 'EXECUTION_UNVERIFIED';
      this.auditMetrics.executionUnverifiedRouteCount = (this.auditMetrics.executionUnverifiedRouteCount || 0) + 1;

      // Track profitable opportunities separately from ordinary rejected route observations
      const trackerRes = this.opportunityTracker.trackOpportunity(candidate, currentSlot);
      candidate.visibilityDurationMs = trackerRes.visibilityDurationMs;
      candidate.observedSnapshotsCount = trackerRes.observedSnapshotsCount;

      // Real survival counting: only after a genuinely new independent market snapshot
      this.auditMetrics.survivalCheckedCount = (this.auditMetrics.survivalCheckedCount || 0) + 1;
      if (trackerRes.isSurvival) {
        candidate.survivalStatus = 'SURVIVED';
        this.auditMetrics.survivalSurvivedCount = (this.auditMetrics.survivalSurvivedCount || 0) + 1;
      } else {
        candidate.survivalStatus = 'UNCHECKED';
      }
    } else {
      this.rejectedCount++;
      this.auditMetrics.rejectedRoutes++;
      for (const reason of candidate.rejectionReasons) {
        this.rejectionBreakdown[reason] = (this.rejectionBreakdown[reason] || 0) + 1;
        if (reason === 'QUOTE_UNVERIFIED' || reason === 'MISSING_TICK_DATA') {
          this.auditMetrics.quoteValidationFailures++;
        }
        if (reason === 'UNSUPPORTED_ROUTE') {
          this.auditMetrics.unsupportedRoutes = (this.auditMetrics.unsupportedRoutes || 0) + 1;
        }
        if (reason === 'STALE_QUOTE' || reason === 'SLOT_MISMATCH' || reason === 'PRICE_CONVERSION_STALE') {
          this.auditMetrics.staleDataRejections++;
        }
      }
    }

    if (isDupe && candidate.status !== 'QUALIFIED_SHADOW') {
      return;
    }

    // Asynchronous non-blocking persistence
    this.repository.saveCandidate(candidate);

    // Notify CLI listeners
    for (const listener of this.candidateListeners) {
      try { listener(candidate); } catch {}
    }
  }

  private recheckSurvivalSync(
    candidate: ArbitrageCandidate,
    legs: QuoterLeg[],
    costs: CostBreakdown,
    currentSlot: number
  ): SurvivalStatus {
    try {
      const sizeUSDC = candidate.optimalSizeUSDC || Number(candidate.inputAmountUSDC) / 1e6;
      const evalRes = this.tradeSizer.evaluateSize(sizeUSDC, legs, costs, currentSlot);
      const minHurdle = this.profitThresholdManager.getThresholdDecimal();
      if (evalRes.isViable && evalRes.conservativeNetUSDC.gte(minHurdle)) {
        return 'SURVIVED';
      }
      return 'DECAYED';
    } catch {
      return 'DECAYED';
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
      const rpcRes = await this.rpc.getMultipleAccountsAndContext(pubkeys);
      this.latencyTracker.recordRpcLatency(performance.now() - rpcStart);

      const snapshotSlot = rpcRes.slot;
      const accounts = rpcRes.value;
      const decodedPools: PoolState[] = [];
      const vaultsToFetch: { pubkey: PublicKey; poolIndex: number; isA: boolean }[] = [];
      const openOrdersToFetch: { pubkey: PublicKey; poolIndex: number; expectedOwner: string }[] = [];

      for (let i = 0; i < pools.length; i++) {
        const poolConfig = pools[i];
        const accountInfo = accounts[i];
        if (!accountInfo) {
          if (poolConfig.dex === 'ORCA_WHIRLPOOL' && poolConfig.verificationStatus === 'QUOTE_UNVERIFIED') {
            this.poolRegistry.updatePoolVerification(poolConfig.id, 'QUOTE_UNVERIFIED', 'ACCOUNT_NOT_FOUND');
            this.routeIndex.updatePoolStatus(poolConfig.id, 'QUOTE_UNVERIFIED');
          }
          continue;
        }

        const adapter = dexRegistry.getAdapter(poolConfig.dex);
        if (adapter) {
          // On-chain program owner & minimum layout revalidation for Orca pools
          if (poolConfig.dex === 'ORCA_WHIRLPOOL') {
            const onChainOwner = accountInfo.owner ? accountInfo.owner.toBase58() : '';
            if (onChainOwner !== KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL) {
              this.poolRegistry.updatePoolVerification(poolConfig.id, 'QUOTE_UNVERIFIED', 'INVALID_PROGRAM_OWNER');
              this.routeIndex.updatePoolStatus(poolConfig.id, 'QUOTE_UNVERIFIED');
              continue;
            }
            if (accountInfo.data.length < 653) {
              this.poolRegistry.updatePoolVerification(poolConfig.id, 'QUOTE_UNVERIFIED', 'INVALID_ACCOUNT_LAYOUT');
              this.routeIndex.updatePoolStatus(poolConfig.id, 'QUOTE_UNVERIFIED');
              continue;
            }
          }

          const decoded = adapter.decodePoolState(accountInfo.data, poolConfig.id, snapshotSlot);
          if (decoded) {
            // Strict mint pair match and positive on-chain liquidity for Orca Whirlpool candidates
            if (poolConfig.dex === 'ORCA_WHIRLPOOL') {
              const matchesMints =
                (decoded.tokenAMint === poolConfig.tokenAMint && decoded.tokenBMint === poolConfig.tokenBMint) ||
                (decoded.tokenAMint === poolConfig.tokenBMint && decoded.tokenBMint === poolConfig.tokenAMint);
              if (!matchesMints) {
                this.poolRegistry.updatePoolVerification(poolConfig.id, 'QUOTE_UNVERIFIED', 'MINT_PAIR_MISMATCH');
                this.routeIndex.updatePoolStatus(poolConfig.id, 'QUOTE_UNVERIFIED');
                continue;
              }

              const extra = decoded.extraData as any;
              const liquidity = BigInt(extra?.liquidity || '0');
              if (liquidity <= 0n) {
                this.poolRegistry.updatePoolVerification(poolConfig.id, 'QUOTE_UNVERIFIED', 'ZERO_LIQUIDITY');
                this.routeIndex.updatePoolStatus(poolConfig.id, 'QUOTE_UNVERIFIED');
                continue;
              }
            }
            const extra = decoded.extraData as any;
            const vaultA = extra?.baseVault || extra?.tokenVaultA || extra?.reserveX;
            const vaultB = extra?.quoteVault || extra?.tokenVaultB || extra?.reserveY;

            if (poolConfig.dex === 'RAYDIUM_AMM' && extra?.openOrders) {
              openOrdersToFetch.push({
                pubkey: new PublicKey(extra.openOrders),
                poolIndex: decodedPools.length,
                expectedOwner: extra.marketProgramId || 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
              });
            }

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

      // Batch vault balance hydration with real RPC context slot and account owner verification
      if (vaultsToFetch.length > 0) {
        try {
          const vRpcStart = performance.now();
          const vRpcRes = await this.rpc.getMultipleAccountsAndContext(vaultsToFetch.map(v => v.pubkey));
          this.latencyTracker.recordRpcLatency(performance.now() - vRpcStart);
          const vaultSlot = vRpcRes.slot;
          const vaultAccounts = vRpcRes.value;

          for (let i = 0; i < vaultsToFetch.length; i++) {
            const vInfo = vaultsToFetch[i];
            const acc = vaultAccounts[i];
            if (acc && acc.data.length >= 72) {
              // Verify owner is SPL Token Program
              const ownerStr = acc.owner ? acc.owner.toBase58() : '';
              if (
                ownerStr &&
                ownerStr !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
                ownerStr !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
              ) {
                continue; // Ignore accounts with mismatched owner
              }

              const amount = acc.data.readBigUInt64LE(64);
              const pool = decodedPools[vInfo.poolIndex];
              if (pool) {
                const extra = (pool.extraData || {}) as any;
                if (vInfo.isA) {
                  pool.reserveA = amount;
                  extra.vaultASlot = vaultSlot;
                  extra.vaultAReceivedAt = Date.now();
                } else {
                  pool.reserveB = amount;
                  extra.vaultBSlot = vaultSlot;
                  extra.vaultBReceivedAt = Date.now();
                }
                pool.slot = vaultSlot;
              }
            }
          }
        } catch {}
      }

      // Step 3: Single bounded attempt to fetch OpenOrders accounts for Raydium V4 pools
      if (openOrdersToFetch.length > 0) {
        try {
          const ooStart = performance.now();
          const ooRes = await this.rpc.getMultipleAccountsAndContext(openOrdersToFetch.map(o => o.pubkey));
          this.latencyTracker.recordRpcLatency(performance.now() - ooStart);
          const ooSlot = ooRes.slot;
          const ooAccounts = ooRes.value;

          for (let i = 0; i < openOrdersToFetch.length; i++) {
            const ooInfo = openOrdersToFetch[i];
            const acc = ooAccounts[i];
            const pool = decodedPools[ooInfo.poolIndex];
            if (!pool) continue;

            const extra = pool.extraData as any;
            let isVerified = false;
            let blockerReason = 'QUOTE_UNVERIFIED';

            if (!acc || !acc.data || acc.data.length < 3228) {
              blockerReason = 'OPENORDERS_LAYOUT_INVALID';
            } else {
              const ownerStr = acc.owner ? acc.owner.toBase58() : '';
              const market = new PublicKey(acc.data.subarray(13, 45)).toBase58();
              const authority = new PublicKey(acc.data.subarray(45, 77)).toBase58();
              const expectedAuthority = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

              if (ownerStr !== ooInfo.expectedOwner && ownerStr !== 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX') {
                blockerReason = 'OPENORDERS_OWNER_MISMATCH';
              } else if (market !== extra?.marketId) {
                blockerReason = 'OPENORDERS_MARKET_MISMATCH';
              } else if (authority !== expectedAuthority) {
                blockerReason = 'OPENORDERS_AUTHORITY_MISMATCH';
              } else {
                // Check snapshot slot consistency between pool and OpenOrders, and verify vault hydration
                const slotGap = Math.abs(snapshotSlot - ooSlot);
                const reservesHydrated = (pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n;
                const vASlot = extra.vaultASlot;
                const vBSlot = extra.vaultBSlot;
                const vAReceivedAt = extra.vaultAReceivedAt;
                const vBReceivedAt = extra.vaultBReceivedAt;

                if (!reservesHydrated) {
                  blockerReason = 'VAULT_RESERVES_UNHYDRATED';
                } else if (!vASlot || !vBSlot || !vAReceivedAt || !vBReceivedAt) {
                  blockerReason = 'MISSING_VAULT_METADATA';
                } else if (Math.abs(vASlot - vBSlot) > 100) {
                  blockerReason = 'INCONSISTENT_VAULT_SNAPSHOT';
                } else if (slotGap > 100) {
                  blockerReason = 'SLOT_MISMATCH';
                } else {
                  isVerified = true;
                  const baseTokenTotal = acc.data.readBigUInt64LE(85);
                  const quoteTokenTotal = acc.data.readBigUInt64LE(101);
                  extra.openOrdersVerified = true;
                  extra.openOrdersBaseTokenTotal = baseTokenTotal.toString();
                  extra.openOrdersQuoteTokenTotal = quoteTokenTotal.toString();
                  extra.lastAccountChangeSlot = ooSlot;
                  extra.lastRpcConfirmationContextSlot = ooSlot;
                  extra.lastConfirmedAt = Date.now();
                  extra.observationFreshnessTtlMs = this.config.OPENORDERS_OBSERVATION_TTL_MS || 30000;
                  extra.openOrdersSlot = ooSlot;
                  extra.verifiedSlot = snapshotSlot;
                  extra.verifiedAt = Date.now();
                  delete extra.unverifiedReason;

                  this.poolRegistry.updatePoolVerification(pool.id, 'VERIFIED_DIRECT');
                  this.routeIndex.updatePoolStatus(pool.id, 'VERIFIED_DIRECT');
                }
              }
            }

            if (!isVerified) {
              extra.openOrdersVerified = false;
              extra.unverifiedReason = blockerReason;
              this.poolRegistry.updatePoolVerification(pool.id, 'QUOTE_UNVERIFIED', blockerReason);
              this.routeIndex.updatePoolStatus(pool.id, 'QUOTE_UNVERIFIED');
            }

            // Map and subscribe to OpenOrders account for real-time WebSocket state maintenance
            const ooPubkeyStr = ooInfo.pubkey.toBase58();
            if (!this.openOrdersToPool.has(ooPubkeyStr)) {
              this.openOrdersToPool.set(ooPubkeyStr, pool.id);
              this.ws.subscribeAccount(ooPubkeyStr, (buf, s, rxTime, monoTime) => {
                this.enqueueUpdate({
                  type: 'OPENORDERS_ACCOUNT',
                  key: ooPubkeyStr,
                  data: buf,
                  slot: s,
                  receivedAtMs: rxTime || Date.now(),
                  monotonicReceiptTime: monoTime || performance.now()
                });
              });
            }
          }
        } catch {
          // Bounded attempt failed or timed out: retain QUOTE_UNVERIFIED and proceed
          for (const ooInfo of openOrdersToFetch) {
            const pool = decodedPools[ooInfo.poolIndex];
            if (pool && pool.extraData) {
              pool.extraData.openOrdersVerified = false;
              pool.extraData.unverifiedReason = 'RPC_TIMEOUT';
              this.poolRegistry.updatePoolVerification(pool.id, 'QUOTE_UNVERIFIED', 'RPC_TIMEOUT');
              this.routeIndex.updatePoolStatus(pool.id, 'QUOTE_UNVERIFIED');
            }
          }
        }
      }

      // Step 4: Batch fetch and subscribe to nearby initialized TickArrays for Orca Whirlpool pools
      const tickArraysToFetch: { pda: PublicKey; poolIndex: number; startTickIndex: number; poolId: string }[] = [];
      for (let pIdx = 0; pIdx < decodedPools.length; pIdx++) {
        const pool = decodedPools[pIdx];
        if (pool.dex === 'ORCA_WHIRLPOOL') {
          const extra = (pool.extraData || {}) as any;
          const tickSpacing = extra.tickSpacing || 1;
          const tickCurrent = extra.tickCurrent;
          if (tickCurrent !== undefined) {
            if (!extra.tickArrays) extra.tickArrays = {};
            const surroundingStarts = getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);
            for (const startIdx of surroundingStarts) {
              const pda = deriveTickArrayPda(pool.id, startIdx);
              const pdaStr = pda.toBase58();
              if (!this.tickArrayToPool.has(pdaStr)) {
                this.tickArrayToPool.set(pdaStr, { poolId: pool.id, startTickIndex: startIdx });
                this.ws.subscribeAccount(pdaStr, (buf, s, rxTime, monoTime) => {
                  this.enqueueUpdate({
                    type: 'TICK_ARRAY_ACCOUNT',
                    key: pdaStr,
                    data: buf,
                    slot: s,
                    receivedAtMs: rxTime || Date.now(),
                    monotonicReceiptTime: monoTime || performance.now()
                  });
                });
              }
              tickArraysToFetch.push({ pda, poolIndex: pIdx, startTickIndex: startIdx, poolId: pool.id });
            }
          }
        }
      }

      if (tickArraysToFetch.length > 0) {
        try {
          const tRpcStart = performance.now();
          const tRpcRes = await this.rpc.getMultipleAccountsAndContext(tickArraysToFetch.map(t => t.pda));
          this.latencyTracker.recordRpcLatency(performance.now() - tRpcStart);
          const tSlot = tRpcRes.slot;
          const tAccounts = tRpcRes.value;

          for (let i = 0; i < tickArraysToFetch.length; i++) {
            const item = tickArraysToFetch[i];
            const acc = tAccounts[i];
            const pool = decodedPools[item.poolIndex];
            if (!pool || !acc || !acc.data) continue;

            const ownerStr = acc.owner ? acc.owner.toBase58() : '';
            if (ownerStr && ownerStr !== KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL) {
              continue;
            }

            const decodedArray = decodeTickArrayAccount(acc.data, item.poolId);
            if (decodedArray) {
              const extra = (pool.extraData || {}) as any;
              if (!extra.tickArrays) extra.tickArrays = {};
              if (!extra.tickArraySlots) extra.tickArraySlots = {};
              if (!extra.tickArrayReceivedAt) extra.tickArrayReceivedAt = {};
              extra.tickArrays[item.startTickIndex] = decodedArray;
              extra.tickArraySlots[item.startTickIndex] = tSlot;
              extra.tickArrayReceivedAt[item.startTickIndex] = Date.now();
            }
          }
        } catch {
          // Bounded timeout: continue without blocking
        }
      }

      for (const pool of decodedPools) {
        pool.receivedAt = Date.now();
        const existing = this.stateCache.getPoolState(pool.id);
        if (existing) {
          if (pool.dex !== 'RAYDIUM_AMM') {
            if (pool.reserveA === 0n && (existing.reserveA ?? 0n) > 0n) pool.reserveA = existing.reserveA;
            if (pool.reserveB === 0n && (existing.reserveB ?? 0n) > 0n) pool.reserveB = existing.reserveB;
          }
        }

        // Safe Promotion: Promote Orca Whirlpools to VERIFIED_DIRECT only when all surrounding tick arrays are hydrated and fresh
        if (pool.dex === 'ORCA_WHIRLPOOL') {
          const extra = (pool.extraData || {}) as any;
          const tickSpacing = extra.tickSpacing || 1;
          const tickCurrent = extra.tickCurrent;
          const liquidity = BigInt(extra?.liquidity || '0');

          if (tickCurrent !== undefined && extra.tickArrays && liquidity > 0n) {
            const surroundingStarts = getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);
            const arrayTimestamps = extra.tickArrayReceivedAt || {};
            const arraySlots = extra.tickArraySlots || {};
            const now = Date.now();
            const ttl = 30000;

            const allSurroundingPresent = surroundingStarts.every(idx => {
              const arr = extra.tickArrays[idx];
              const t = arrayTimestamps[idx];
              const s = arraySlots[idx];
              return arr && t && (now - t <= ttl) && s && Math.abs(snapshotSlot - s) <= 100;
            });

            if (allSurroundingPresent) {
              delete extra.unverifiedReason;
              this.poolRegistry.updatePoolVerification(pool.id, 'VERIFIED_DIRECT');
              this.routeIndex.updatePoolStatus(pool.id, 'VERIFIED_DIRECT');
            } else if (!this.poolRegistry.isPoolVerified(pool.id)) {
              this.poolRegistry.updatePoolVerification(pool.id, 'QUOTE_UNVERIFIED', 'MISSING_TICK_DATA');
              this.routeIndex.updatePoolStatus(pool.id, 'QUOTE_UNVERIFIED');
            }
          }
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
    const configA = this.poolRegistry.getPool(poolA.id);
    const configB = this.poolRegistry.getPool(poolB.id);
    const isDirect = (configA?.verificationStatus === 'VERIFIED_DIRECT') && (configB?.verificationStatus === 'VERIFIED_DIRECT');
    const routeLastVerified = isDirect ? Math.min(configA?.lastVerifiedAt || 0, configB?.lastVerifiedAt || 0) : 0;

    const route: IndexedDirectedRoute = {
      routeId: `${poolA.id}->${poolB.id}`,
      cycleType: '2_LEG',
      isIntraDex: poolA.dex === poolB.dex,
      isDirectToDirect: isDirect,
      priorityScore: 1000,
      legs: [
        { poolId: poolA.id, dex: poolA.dex, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT },
        { poolId: poolB.id, dex: poolB.dex, inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT }
      ],
      poolIds: [poolA.id, poolB.id],
      poolAId: poolA.id,
      poolBId: poolB.id,
      dexA: poolA.dex,
      dexB: poolB.dex,
      inputMint: CANONICAL_USDC_MINT,
      intermediateMint: CANONICAL_WSOL_MINT,
      outputMint: CANONICAL_USDC_MINT,
      estimatedAccounts: 30,
      estimatedComputeUnits: 150000,
      state: isDirect ? 'VERIFIED' : 'BLOCKED',
      staticDependencies: [],
      dynamicDependencies: [],
      protocolAdapterVersion: '1.4.0',
      lastVerifiedAt: routeLastVerified,
      isUnprofitablePreserved: true
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

    // FIX 1: Ensure reported readiness reflects current freshness, feed health, and slot limits
    const expiredRoutes = this.routeIndex.expireStaleReadyRoutes(
      (id) => this.stateCache.getPoolState(id),
      this.config.MAX_QUOTE_AGE_MS || 2500,
      this.config.MAX_SLOT_GAP || 10,
      wsStats.lastSlot
    );
    for (const expired of expiredRoutes) {
      this.repository.updateRouteReadiness(expired.routeId, false, expired.verificationDetails);
    }

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

  public getAuditMetrics(): AuditMetrics {
    const lifecycleStats = this.opportunityTracker.getLifecycleStats();
    return {
      ...this.auditMetrics,
      configuredRouteCount: this.routeIndex.getAllRoutes().length,
      maxOpportunityVisibilityMs: lifecycleStats.maxVisibilityDurationMs,
      meanOpportunityVisibilityMs: lifecycleStats.meanVisibilityDurationMs,
      orcaTickBoundaryAttempts: this.tradeSizer.orcaTickBoundaryAttempts,
      orcaOtherFailureAttempts: this.tradeSizer.orcaOtherFailureAttempts,
      raydiumReconfirmationAttempts: this.auditMetrics.raydiumReconfirmationAttempts || 0,
      raydiumReconfirmationSuccesses: this.auditMetrics.raydiumReconfirmationSuccesses || 0
    };
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

  public getStateCache(): StateCache {
    return this.stateCache;
  }

  public getPoolRegistry(): PoolRegistry {
    return this.poolRegistry;
  }

  public getRepository(): ArbitrageRepository {
    return this.repository;
  }

  public getRouteLibrarySummary(): RouteSummaryStats {
    return this.repository.getRouteSummaryStats();
  }

  private syncRouteLibraryToStorage(): void {
    try {
      const pools = this.poolRegistry.getAllPools();
      const verifiedPoolRecords: VerifiedPoolRecord[] = pools.map(p => ({
        poolId: p.id,
        dex: p.dex,
        programId: p.programId,
        tokenAMint: p.tokenAMint,
        tokenBMint: p.tokenBMint,
        feeBps: p.feeBps,
        verificationStatus: p.verificationStatus || 'QUOTE_UNVERIFIED',
        blockerReason: p.blockerReason,
        initialLiquidityUsd: p.initialLiquidityUsd || 0,
        accountLayoutSize: 0,
        lastVerifiedAt: p.lastVerifiedAt || 0,
        createdAt: Date.now()
      }));
      this.repository.upsertVerifiedPools(verifiedPoolRecords);

      const permanentRoutes = this.routeIndex.getAllPermanentRecords();
      this.repository.upsertRoutes(permanentRoutes);
    } catch (err) {
      this.repository.recordPersistenceError('syncRouteLibraryToStorage', err);
    }
  }

  public getCompetitorAnalyzer(): CompetitorAnalyzer {
    return this.competitorAnalyzer;
  }

  public getCompetitionScorer(): CompetitionScorer {
    return this.competitionScorer;
  }

  public getOpportunityTracker(): OpportunityTracker {
    return this.opportunityTracker;
  }

  public getProfitThresholdManager(): ProfitThresholdManager {
    return this.profitThresholdManager;
  }

  public stop(): void {
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.ws.disconnect();
    this.repository.flushSync();
    this.repository.close();
  }
}
