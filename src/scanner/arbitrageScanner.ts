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
  AuditMetrics
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
import { TradeSizer, QuoterLeg } from '../profit/tradeSizer.js';
import { CompetitorAnalyzer } from '../competition/analyzer.js';
import { CompetitionScorer } from '../profit/competitionScorer.js';
import { OpportunityTracker } from './opportunityTracker.js';

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
    competitorTxsAnalyzed: 0,
    averageCompetitionScore: 0
  };

  // Live timestamped SOL/USDC price (null initially: zero fictitious default price permitted)
  private currentSolPriceUSDC: Decimal | null = null;
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
    this.tradeSizer = new TradeSizer(config);

    // Initialize Competition-Aware Intelligence Components
    this.competitorAnalyzer = new CompetitorAnalyzer(this.rpc);
    this.competitionScorer = new CompetitionScorer();
    this.opportunityTracker = new OpportunityTracker();

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
        }
      }
    } finally {
      this.isDrainingQueue = false;
    }
  }

  private processPoolAccountUpdate(update: QueuedAccountUpdate): void {
    const poolConfig = this.poolRegistry.getPool(update.key);
    if (!poolConfig) return;

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

      // Preserve existing hydrated vault reserves if incoming update lacks them
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
    const quoterLegs: QuoterLeg[] = [];
    let oldestSlot = Infinity;

    for (let idx = 0; idx < route.legs.length; idx++) {
      const legDef = route.legs[idx];
      const pool = this.stateCache.getPoolState(legDef.poolId);
      if (!pool) return;

      // Fail closed if AMM reserves are not yet hydrated
      if (pool.dex === 'RAYDIUM_AMM' && ((pool.reserveA ?? 0n) <= 0n || (pool.reserveB ?? 0n) <= 0n)) return;

      const adapter = dexRegistry.getAdapter(legDef.dex);
      if (!adapter) return;

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

    const currentSlot = this.ws.getCurrentSlot();
    const wsConnected = this.ws.getHealth() !== 'DISCONNECTED';

    // Fail closed: Require fresh, live, non-fictitious SOL/USDC price for fee conversions
    if (!this.currentSolPriceUSDC || this.lastSolPriceTime <= 0) {
      return;
    }

    // Calculate current execution costs
    const costResult = this.costModel.calculateCosts({
      solPriceUSDC: this.currentSolPriceUSDC,
      solPriceTimestamp: this.lastSolPriceTime,
      requiresAtaSetup: route.legs.some(l => l.inputMint === CANONICAL_WSOL_MINT || l.outputMint === CANONICAL_WSOL_MINT)
    });

    if (!costResult.isComplete || !costResult.breakdown) return;

    // Fast optimal trade sizing
    const quoteStart = performance.now();
    const sizerResult = this.tradeSizer.findOptimalSize(quoterLegs, costResult.breakdown, currentSlot);
    const quoteDurationUs = (performance.now() - quoteStart) * 1000;
    this.latencyTracker.recordQuoteDuration(quoteDurationUs);

    this.quotesProducedCount += sizerResult.evaluatedSizesCount * route.legs.length;

    if (sizerResult.optimalQuotes.length < 2) return;

    // Profit validation & audit metrics
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

    const validationStart = performance.now();
    const candidate = this.calculator.evaluateCandidate({
      initialAmountUSDC: BigInt(Math.floor(sizerResult.optimalSizeUSDC * 1e6)),
      leg1Quote: sizerResult.optimalQuotes[0],
      leg2Quote: sizerResult.optimalQuotes[1],
      leg3Quote: sizerResult.optimalQuotes[2],
      cycleType: route.cycleType,
      optimalSizeUSDC: sizerResult.optimalSizeUSDC,
      sizingMethod: sizerResult.sizingMethod,
      costs: costResult.breakdown,
      currentSlot,
      wsConnected,
      solPriceTimestamp: this.lastSolPriceTime
    });

    // Competition-Aware Opportunity Scoring (Section 4)
    const poolMetrics = route.legs.map(l => this.competitorAnalyzer.getCachedMetrics(l.poolId));
    const scoreResult = this.competitionScorer.scoreCandidate(candidate, poolMetrics);
    candidate.competitionScore = scoreResult.score;
    candidate.executionProbability = scoreResult.executionProbability;
    candidate.scoringBreakdown = scoreResult.breakdown;

    // Continuous Opportunity Duration Tracking (Section 5)
    this.opportunityTracker.trackOpportunity(candidate, currentSlot);

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

    // Deduplicate identical repeated opportunities
    const isDupe = this.stateCache.isDuplicate({
      route: route.routeId,
      amountUSDC: candidate.inputAmountUSDC,
      netProfitUSDC: candidate.minConservativeNetUSDC
    });

    if (!isDupe) {
      this.auditMetrics.uniqueOpportunities++;
    }

    if (candidate.status === 'QUALIFIED_SHADOW') {
      this.qualifiedCount++;
      this.auditMetrics.candidatesConservativeQualified++;
      this.auditMetrics.shadowQualifiedCount = (this.auditMetrics.shadowQualifiedCount || 0) + 1;

      // Survival re-check against current state
      const survival = this.recheckSurvivalSync(candidate, quoterLegs, costResult.breakdown, currentSlot);
      candidate.survivalStatus = survival;
      this.auditMetrics.survivalCheckedCount = (this.auditMetrics.survivalCheckedCount || 0) + 1;
      if (survival === 'SURVIVED') {
        this.auditMetrics.survivalSurvivedCount = (this.auditMetrics.survivalSurvivedCount || 0) + 1;
      } else {
        this.auditMetrics.survivalDecayedCount = (this.auditMetrics.survivalDecayedCount || 0) + 1;
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
          this.auditMetrics.unsupportedRoutes++;
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
      if (evalRes.isViable && evalRes.conservativeNetUSDC.gte(this.config.MIN_NET_PROFIT_USDC)) {
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

      for (let i = 0; i < pools.length; i++) {
        const poolConfig = pools[i];
        const accountInfo = accounts[i];
        if (!accountInfo) continue;

        const adapter = dexRegistry.getAdapter(poolConfig.dex);
        if (adapter) {
          const decoded = adapter.decodePoolState(accountInfo.data, poolConfig.id, snapshotSlot);
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
                if (vInfo.isA) pool.reserveA = amount;
                else pool.reserveB = amount;
                pool.slot = vaultSlot;
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
      cycleType: '2_LEG',
      isIntraDex: poolA.dex === poolB.dex,
      isDirectToDirect: true,
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
      estimatedComputeUnits: 150000
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

  public getAuditMetrics(): AuditMetrics {
    const lifecycleStats = this.opportunityTracker.getLifecycleStats();
    return {
      ...this.auditMetrics,
      maxOpportunityVisibilityMs: lifecycleStats.maxVisibilityDurationMs,
      meanOpportunityVisibilityMs: lifecycleStats.meanVisibilityDurationMs
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

  public getRepository(): ArbitrageRepository {
    return this.repository;
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
