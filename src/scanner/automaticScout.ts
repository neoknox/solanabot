import { PublicKey } from '@solana/web3.js';
import {
  OrcaPoolDiscovery,
  RaydiumPoolDiscovery,
  DiscoveredCandidate,
  VerificationResult,
  saveDiscoveredCandidates,
  OrcaDiscoveryOptions,
  RaydiumDiscoveryOptions
} from './poolDiscovery.js';
import { PoolRegistry, PoolConfig } from './poolRegistry.js';
import { RouteIndex } from './routeIndex.js';
import { ArbitrageRepository } from '../storage/repository.js';
import { SolanaRpcProvider } from '../providers/solanaRpc.js';
import { ScoutRunRecord, ScoutMetricsSummary } from '../types/index.js';

export interface AutomaticScoutOptions {
  intervalMs?: number; // Daily by default (24 hours = 86,400,000 ms)
  runOnStartup?: boolean;
  persistenceFilePath?: string;
  maxCandidatesPerRun?: number;
  batchRpcConcurrency?: number;
  orcaOptions?: OrcaDiscoveryOptions;
  raydiumOptions?: RaydiumDiscoveryOptions;
}

export interface ScoutCycleResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_ALREADY_RUNNING';
  source: string;
  candidatesFound: number;
  candidatesVerified: number;
  candidatesRejected: number;
  routesGenerated: number;
  durationMs: number;
  routeGenerationTimeMs: number;
  errorMessage?: string;
}

export class AutomaticScout {
  private poolRegistry: PoolRegistry;
  private routeIndex: RouteIndex;
  private repository: ArbitrageRepository;
  private rpcProvider: SolanaRpcProvider;
  private options: AutomaticScoutOptions;

  private orcaDiscovery: OrcaPoolDiscovery;
  private raydiumDiscovery: RaydiumPoolDiscovery;

  private isRunning = false;
  private isCycleActive = false;
  private timer: NodeJS.Timeout | null = null;
  private currentStatus: 'IDLE' | 'RUNNING' | 'ERROR' = 'IDLE';
  private lastError: string | null = null;
  private lastRouteGenTimeMs = 0;

  private totalDiscoveredCount = 0;
  private totalVerifiedCount = 0;
  private totalRejectedCount = 0;

  private onPoolActivated?: (pool: PoolConfig) => Promise<void> | void;

  constructor(
    poolRegistry: PoolRegistry,
    routeIndex: RouteIndex,
    repository: ArbitrageRepository,
    rpcProvider: SolanaRpcProvider,
    options: AutomaticScoutOptions = {},
    onPoolActivated?: (pool: PoolConfig) => Promise<void> | void
  ) {
    this.poolRegistry = poolRegistry;
    this.routeIndex = routeIndex;
    this.repository = repository;
    this.rpcProvider = rpcProvider;
    this.options = {
      intervalMs: options.intervalMs ?? 24 * 60 * 60 * 1000,
      runOnStartup: options.runOnStartup ?? true,
      persistenceFilePath: options.persistenceFilePath || './data/discovered_pools.json',
      maxCandidatesPerRun: options.maxCandidatesPerRun || 50,
      batchRpcConcurrency: options.batchRpcConcurrency || 5,
      ...options
    };
    this.onPoolActivated = onPoolActivated;

    this.orcaDiscovery = new OrcaPoolDiscovery(this.options.orcaOptions);
    this.raydiumDiscovery = new RaydiumPoolDiscovery(this.options.raydiumOptions);
  }

  public setOnPoolActivated(fn: (pool: PoolConfig) => Promise<void> | void): void {
    this.onPoolActivated = fn;
  }

  /**
   * Starts the background Scout scheduler. Resumes schedule from persisted timestamp if available.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const interval = this.options.intervalMs!;
    const lastRunRaw = this.repository.getScoutMetadata('last_scout_run_at');
    const lastRunAt = lastRunRaw ? parseInt(lastRunRaw, 10) : 0;
    const now = Date.now();
    const elapsed = now - lastRunAt;

    let initialDelayMs = 0;
    if (lastRunAt > 0 && elapsed < interval) {
      initialDelayMs = interval - elapsed;
    } else if (!this.options.runOnStartup) {
      initialDelayMs = interval;
    } else {
      // Run initial cycle shortly after startup (1 second) to allow initial snapshot hydration
      initialDelayMs = 1000;
    }

    this.scheduleNext(initialDelayMs);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(async () => {
      try {
        await this.runScoutCycle('SCHEDULED');
      } catch (err: any) {
        console.error('[AutomaticScout] Uncaught error during scheduled Scout cycle:', err);
      } finally {
        if (this.isRunning) {
          this.scheduleNext(this.options.intervalMs!);
        }
      }
    }, delayMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Concurrency Guard: Runs one bounded discovery cycle across Orca and Raydium.
   * If a cycle is already active, skips cleanly without throwing.
   */
  public async runScoutCycle(source: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<ScoutCycleResult> {
    if (this.isCycleActive) {
      return {
        status: 'SKIPPED_ALREADY_RUNNING',
        source,
        candidatesFound: 0,
        candidatesVerified: 0,
        candidatesRejected: 0,
        routesGenerated: 0,
        durationMs: 0,
        routeGenerationTimeMs: 0,
        errorMessage: 'A Scout discovery cycle is already in progress'
      };
    }

    this.isCycleActive = true;
    this.currentStatus = 'RUNNING';
    const startedAt = Date.now();
    let candidatesFound = 0;
    let candidatesVerified = 0;
    let candidatesRejected = 0;
    let routesGenerated = 0;
    let errorMessage: string | undefined;

    try {
      // 1. Discover candidates from Orca and Raydium in parallel (with failure isolation)
      const [orcaRes, raydiumRes] = await Promise.allSettled([
        this.orcaDiscovery.discoverCandidates(),
        this.raydiumDiscovery.discoverCandidates()
      ]);

      const allCandidates: DiscoveredCandidate[] = [];
      const seenAddresses = new Set<string>();
      const discoveryErrors: string[] = [];

      let orcaFailed = false;
      if (orcaRes.status === 'fulfilled') {
        if (orcaRes.value.apiStatus === 'FAILED') {
          orcaFailed = true;
          discoveryErrors.push(...orcaRes.value.errors);
        } else {
          for (const c of orcaRes.value.candidates) {
            if (!seenAddresses.has(c.address)) {
              seenAddresses.add(c.address);
              allCandidates.push(c);
            }
          }
        }
      } else {
        orcaFailed = true;
        discoveryErrors.push(String(orcaRes.reason));
      }

      let raydiumFailed = false;
      if (raydiumRes.status === 'fulfilled') {
        if (raydiumRes.value.apiStatus === 'FAILED') {
          raydiumFailed = true;
          discoveryErrors.push(...raydiumRes.value.errors);
        } else {
          for (const c of raydiumRes.value.candidates) {
            if (!seenAddresses.has(c.address)) {
              seenAddresses.add(c.address);
              allCandidates.push(c);
            }
          }
        }
      } else {
        raydiumFailed = true;
        discoveryErrors.push(String(raydiumRes.reason));
      }

      if (orcaFailed && raydiumFailed) {
        throw new Error(`All discovery sources failed: ${discoveryErrors.join('; ')}`);
      }

      candidatesFound = allCandidates.length;
      this.totalDiscoveredCount += candidatesFound;

      // Filter candidates: limit to maxCandidatesPerRun
      const candidatesToProcess = allCandidates.slice(0, this.options.maxCandidatesPerRun);
      const verifiedPoolsForPersistence: DiscoveredCandidate[] = [];

      // 2. Perform on-chain verification in bounded concurrency chunks
      const concurrency = this.options.batchRpcConcurrency || 5;
      for (let i = 0; i < candidatesToProcess.length; i += concurrency) {
        const chunk = candidatesToProcess.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (candidate) => {
            // Skip already registered pools
            if (this.poolRegistry.getPool(candidate.address)) {
              return null;
            }

            if (candidate.source === 'RAYDIUM_API') {
              return await this.raydiumDiscovery.verifyCandidateOnChain(candidate, this.rpcProvider);
            } else {
              return await this.orcaDiscovery.verifyCandidateOnChain(candidate, this.rpcProvider);
            }
          })
        );

        for (let j = 0; j < chunk.length; j++) {
          const res = chunkResults[j];
          if (!res) continue; // Already registered

          if (res.verified && res.poolConfig) {
            candidatesVerified++;
            this.totalVerifiedCount++;

            // Step 4.1: Register pool in poolRegistry
            this.poolRegistry.register(res.poolConfig);
            verifiedPoolsForPersistence.push(chunk[j]);

            // Persist pool record in SQLite
            try {
              this.repository.saveVerifiedPool({
                poolId: res.poolConfig.id,
                dex: res.poolConfig.dex,
                programId: res.poolConfig.programId,
                tokenAMint: res.poolConfig.tokenAMint,
                tokenBMint: res.poolConfig.tokenBMint,
                feeBps: res.poolConfig.feeBps,
                initialLiquidityUsd: res.poolConfig.initialLiquidityUsd || 0,
                verificationStatus: res.poolConfig.verificationStatus || 'QUOTE_UNVERIFIED',
                blockerReason: res.poolConfig.blockerReason,
                accountLayoutSize: res.dataLength || 0,
                lastVerifiedAt: res.poolConfig.lastVerifiedAt || 0,
                createdAt: Date.now()
              });
            } catch (err) {
              this.repository.recordPersistenceError('saveVerifiedPool', err);
            }

            // Step 4.2: Incrementally generate directed 2-leg and 3-leg cycles
            const genStart = performance.now();
            const newRoutes = this.routeIndex.addPoolAndGenerateRoutes(res.poolConfig);
            this.lastRouteGenTimeMs = Math.round(performance.now() - genStart);
            routesGenerated += newRoutes.length;

            // Step 4.3: Persist newly generated routes in SQLite library
            for (const route of newRoutes) {
              try {
                this.repository.saveRoute(this.routeIndex.toPermanentRecord(route));
              } catch (err) {
                this.repository.recordPersistenceError('saveRoute', err);
              }
            }

            // Step 4.4 & 4.5: Hot-activate WebSocket subscriptions and hydrate state via callback
            if (this.onPoolActivated) {
              try {
                await this.onPoolActivated(res.poolConfig);
              } catch (activateErr) {
                console.warn(`[AutomaticScout] Failed to hot-activate pool ${res.poolConfig.id}:`, activateErr);
              }
            }
          } else {
            candidatesRejected++;
            this.totalRejectedCount++;
          }
        }
      }

      // Step 4.6: Atomically persist newly verified pools to JSON file
      if (this.options.persistenceFilePath && verifiedPoolsForPersistence.length > 0) {
        saveDiscoveredCandidates(verifiedPoolsForPersistence, this.options.persistenceFilePath);
      }

      this.currentStatus = 'IDLE';
      this.lastError = null;
    } catch (err: any) {
      this.currentStatus = 'ERROR';
      this.lastError = err.message || String(err);
      errorMessage = this.lastError || undefined;
      console.error('[AutomaticScout] Discovery cycle failed cleanly:', err);
    } finally {
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      this.isCycleActive = false;

      // Persist last completed discovery timestamp in SQLite metadata
      try {
        this.repository.setScoutMetadata('last_scout_run_at', completedAt.toString());
      } catch (err) {
        this.repository.recordPersistenceError('setScoutMetadata', err);
      }

      // Record scout run log in SQLite
      try {
        const runId = `scout_${startedAt}_${Math.random().toString(36).substring(2, 7)}`;
        const runStatus = errorMessage ? 'FAILED' : 'SUCCESS';
        this.repository.recordScoutRun({
          runId,
          startedAt,
          completedAt,
          status: runStatus,
          candidatesFound,
          candidatesVerified,
          candidatesRejected,
          newPoolsRegistered: candidatesVerified,
          newRoutesGenerated: routesGenerated,
          errors: errorMessage ? [errorMessage] : [],
          durationMs
        });
      } catch (err) {
        this.repository.recordPersistenceError('recordScoutRun', err);
      }

      return {
        status: errorMessage ? 'FAILED' : 'SUCCESS',
        source,
        candidatesFound,
        candidatesVerified,
        candidatesRejected,
        routesGenerated,
        durationMs,
        routeGenerationTimeMs: this.lastRouteGenTimeMs,
        errorMessage
      };
    }
  }

  /**
   * Computes comprehensive Scout and Route metrics for HUD and health observability.
   */
  public getMetrics(): ScoutMetricsSummary {
    const lastRunRaw = this.repository.getScoutMetadata('last_scout_run_at');
    const lastRunTimestamp = lastRunRaw ? parseInt(lastRunRaw, 10) : null;
    const nextScheduledScoutRun = lastRunTimestamp
      ? lastRunTimestamp + (this.options.intervalMs || 24 * 60 * 60 * 1000)
      : null;

    const allRoutes = this.routeIndex.getAllRoutes();
    const verifiedRoutesCount = this.routeIndex.getVerifiedRouteCount();
    const readyRoutesCount = this.routeIndex.getReadyRouteCount();
    const staleRoutesCount = this.routeIndex.getStaleRouteCount();
    const blockedRoutesCount = this.routeIndex.getBlockedRouteCount();
    const twoLegRoutesCount = this.routeIndex.getTwoLegRouteCount();
    const threeLegRoutesCount = this.routeIndex.getThreeLegRouteCount();
    const intraDexRoutesCount = this.routeIndex.getIntraDexRouteCount();
    const interDexRoutesCount = this.routeIndex.getInterDexRouteCount();

    return {
      lastScoutRunTimestamp: lastRunTimestamp,
      nextScheduledScoutRun,
      scoutStatus: this.currentStatus,
      totalDiscoveredPools: this.totalDiscoveredCount,
      totalVerifiedPools: this.totalVerifiedCount,
      totalRejectedPools: this.totalRejectedCount,
      totalRoutesInLibrary: allRoutes.length,
      verifiedRoutesCount,
      readyRoutesCount,
      staleRoutesCount,
      blockedRoutesCount,
      twoLegRoutesCount,
      threeLegRoutesCount,
      intraDexRoutesCount,
      interDexRoutesCount,
      routeGenerationTimeMs: this.lastRouteGenTimeMs,
      lastScoutError: this.lastError
    };
  }

  public getStatus(): 'IDLE' | 'RUNNING' | 'ERROR' {
    return this.currentStatus;
  }

  public isBusy(): boolean {
    return this.isCycleActive;
  }
}
