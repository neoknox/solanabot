import { PoolConfig, VerificationStatus } from './poolRegistry.js';
import {
  DexType,
  CycleType,
  RouteState,
  StaticAccountDependency,
  DynamicAccountDependency,
  PermanentRouteRecord
} from '../types/index.js';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  ALLOWLISTED_MINTS,
  KNOWN_PROGRAM_IDS
} from '../config/index.js';

export interface RouteLegInfo {
  poolId: string;
  dex: DexType;
  inputMint: string;
  outputMint: string;
}

export interface IndexedDirectedRoute {
  routeId: string;
  cycleType: CycleType;
  isIntraDex: boolean;
  isDirectToDirect: boolean;
  priorityScore: number;
  legs: RouteLegInfo[];
  poolIds: string[];

  // Legacy & 2-leg backward compatibility
  poolAId: string;
  poolBId: string;
  dexA: DexType;
  dexB: DexType;
  inputMint: string;
  intermediateMint: string;
  outputMint: string;

  // 3-leg cycle extensions
  poolCId?: string;
  dexC?: DexType;
  tokenBMint?: string;

  // Solana Transaction limits validation
  estimatedAccounts: number;
  estimatedComputeUnits: number;

  // Phase 1.4 Permanent Route Library additions
  state: RouteState;
  staticDependencies: StaticAccountDependency[];
  dynamicDependencies: DynamicAccountDependency[];
  protocolAdapterVersion: string;
  lastVerifiedAt: number;
  isUnprofitablePreserved: boolean;
  lastQuoteExpectedNetUSDC?: string;
  lastQuoteTimestamp?: number;
  verificationDetails?: string;

  // Phase 1.6 Uptime & Readiness metrics additions
  readyDurationMs?: number;
  lastBecameReadyAt?: number;
}

export interface RouteBottleneckBreakdown {
  unverifiedPool: number;
  unsupportedAdapter: number;
  missingTickArrays: number;
  missingVaultOrOpenOrders: number;
  expiredQuote: number;
  expiredPoolObservation: number;
  slotMismatch: number;
  websocketDelay: number;
  rpcHydrationFailure: number;
  incompletePricing: number;
  insufficientLiquidity: number;
  other: number;
}

export interface QuoteAgeDistribution {
  under500ms: number;
  from500to1000ms: number;
  from1000to2000ms: number;
  from2000to2500ms: number;
  over2500ms: number;
}

export interface SlotLagDistribution {
  lag0to1: number;
  lag2to4: number;
  lag5to7: number;
  lag8to10: number;
  lagOver10: number;
}

export interface ReadyMetricsSummary {
  currentReady: number;
  peakReady: number;
  minReady: number;
  timeWeightedReadyAvg: number;
  p10ReadyCount: number;
  totalSamples: number;
}

export interface RouteUptimeStats {
  routeId: string;
  state: RouteState;
  readyDurationMs: number;
  uptimePercent: number;
}

export class RouteIndex {
  // Token Mint -> Pools trading this token
  private tokenToPools = new Map<string, PoolConfig[]>();

  // Pool ID -> Directed Routes where this pool is involved
  private poolToRoutes = new Map<string, IndexedDirectedRoute[]>();

  // Route ID -> Directed Route for O(1) lookup
  private routeById = new Map<string, IndexedDirectedRoute>();

  // All indexed directed routes sorted by priority
  private allRoutes: IndexedDirectedRoute[] = [];

  // Pool ID -> PoolConfig snapshot for dynamic classification
  private poolConfigs = new Map<string, PoolConfig>();

  // Route lifecycle transition counters
  private readyToStaleTransitions = 0;
  private staleToReadyRecoveries = 0;
  private peakReadyCount = 0;
  private readySamples: number[] = [];

  constructor(pools: PoolConfig[]) {
    this.buildIndices(pools);
  }

  public rebuild(pools: PoolConfig[]): void {
    this.tokenToPools.clear();
    this.poolToRoutes.clear();
    this.routeById.clear();
    this.allRoutes = [];
    this.poolConfigs.clear();
    this.buildIndices(pools);
  }

  public updatePoolStatus(poolId: string, status: VerificationStatus, lastVerifiedAt?: number): IndexedDirectedRoute[] {
    const pool = this.poolConfigs.get(poolId);
    if (pool) {
      pool.verificationStatus = status;
      if (lastVerifiedAt !== undefined) {
        pool.lastVerifiedAt = lastVerifiedAt;
      } else if (status === 'VERIFIED_DIRECT' && !pool.lastVerifiedAt) {
        pool.lastVerifiedAt = Date.now();
      } else if (status === 'QUOTE_UNVERIFIED') {
        pool.lastVerifiedAt = 0;
      }
    }

    const changedRoutes: IndexedDirectedRoute[] = [];
    const affectedRoutes = this.poolToRoutes.get(poolId) || [];
    for (const route of affectedRoutes) {
      const prevState = route.state;
      const prevDirect = route.isDirectToDirect;

      const isDirect = route.poolIds.every(id => {
        const cfg = this.poolConfigs.get(id);
        return cfg ? this.isPoolVerifiedDirect(cfg) : false;
      });

      route.isDirectToDirect = isDirect;
      if (!isDirect) {
        if (route.state === 'READY') {
          this.readyToStaleTransitions++;
          if (route.lastBecameReadyAt) {
            route.readyDurationMs = (route.readyDurationMs || 0) + (Date.now() - route.lastBecameReadyAt);
            route.lastBecameReadyAt = undefined;
          }
        }
        route.state = 'BLOCKED';
        route.verificationDetails = `DEPENDENCY_UNVERIFIED:${poolId}`;
        route.lastVerifiedAt = 0;
      } else {
        if (route.state === 'BLOCKED') {
          route.state = 'VERIFIED';
          route.verificationDetails = undefined;
        }
        route.lastVerifiedAt = Math.min(...route.poolIds.map(id => this.poolConfigs.get(id)?.lastVerifiedAt || 0));
      }

      if (route.state !== prevState || route.isDirectToDirect !== prevDirect) {
        changedRoutes.push(route);
      }

      let priority = 0;
      if (route.isDirectToDirect) priority += (route.cycleType === '3_LEG' ? 800 : 1000);
      else if (route.poolIds.some(id => {
        const cfg = this.poolConfigs.get(id);
        return cfg ? this.isPoolVerifiedDirect(cfg) : false;
      })) priority += 500;

      if (route.isIntraDex) priority += (route.cycleType === '3_LEG' ? 150 : 200);

      const poolA = this.poolConfigs.get(route.poolAId);
      const poolB = this.poolConfigs.get(route.poolBId);
      priority += Math.min(
        500,
        Math.floor(((poolA?.initialLiquidityUsd || 0) + (poolB?.initialLiquidityUsd || 0)) / 100000)
      );

      route.priorityScore = priority;
    }

    this.allRoutes.sort((a, b) => b.priorityScore - a.priorityScore);
    return changedRoutes;
  }

  private isPoolVerifiedDirect(pool: PoolConfig): boolean {
    if (pool.verificationStatus) {
      return pool.verificationStatus === 'VERIFIED_DIRECT';
    }
    return pool.dex === 'ORCA_WHIRLPOOL';
  }

  private isDirectDex(dex: DexType): boolean {
    // Only Orca Whirlpool is verified direct
    // Raydium AMM V4 is marked QUOTE_UNVERIFIED due to BLOCKED_RPC_TIMEOUT on public OpenOrders account
    // Meteora DLMM is marked QUOTE_UNVERIFIED due to missing bin-array streaming
    return dex === 'ORCA_WHIRLPOOL';
  }

  private getPoolPair(pool: PoolConfig): [string, string] {
    return [pool.tokenAMint, pool.tokenBMint];
  }

  private poolTradesTokens(pool: PoolConfig, mintX: string, mintY: string): boolean {
    return (
      (pool.tokenAMint === mintX && pool.tokenBMint === mintY) ||
      (pool.tokenAMint === mintY && pool.tokenBMint === mintX)
    );
  }

  private estimateLegAccounts(dex: DexType): number {
    switch (dex) {
      case 'RAYDIUM_AMM': return 18;
      case 'ORCA_WHIRLPOOL': return 12;
      case 'METEORA_DLMM': return 16;
      case 'RAYDIUM_CLMM': return 15;
      default: return 12;
    }
  }

  private estimateLegComputeUnits(dex: DexType): number {
    switch (dex) {
      case 'RAYDIUM_AMM': return 65000;
      case 'ORCA_WHIRLPOOL': return 95000;
      case 'METEORA_DLMM': return 120000;
      default: return 80000;
    }
  }

  private buildDependenciesForLegs(legs: RouteLegInfo[]): {
    staticDependencies: StaticAccountDependency[];
    dynamicDependencies: DynamicAccountDependency[];
  } {
    const staticDeps: StaticAccountDependency[] = [];
    const dynamicDeps: DynamicAccountDependency[] = [];
    const seenStatic = new Set<string>();
    const seenDynamic = new Set<string>();

    for (const leg of legs) {
      const pool = this.poolConfigs.get(leg.poolId);
      if (!pool) continue;

      if (!seenStatic.has(leg.poolId)) {
        staticDeps.push({
          pubkey: leg.poolId,
          role: 'POOL_ACCOUNT',
          isWritable: true,
          isSigner: false
        });
        seenStatic.add(leg.poolId);
      }

      if (!seenStatic.has(pool.programId)) {
        staticDeps.push({
          pubkey: pool.programId,
          role: 'PROGRAM_ID',
          isWritable: false,
          isSigner: false
        });
        seenStatic.add(pool.programId);
      }

      if (!seenStatic.has(leg.inputMint)) {
        staticDeps.push({
          pubkey: leg.inputMint,
          role: 'MINT_A',
          isWritable: false,
          isSigner: false
        });
        seenStatic.add(leg.inputMint);
      }
      if (!seenStatic.has(leg.outputMint)) {
        staticDeps.push({
          pubkey: leg.outputMint,
          role: 'MINT_B',
          isWritable: false,
          isSigner: false
        });
        seenStatic.add(leg.outputMint);
      }

      if (!seenDynamic.has(leg.poolId)) {
        dynamicDeps.push({
          addressType: 'RESOLVED_PUBKEY',
          pubkey: leg.poolId,
          isResolved: true,
          role: 'POOL_ACCOUNT',
          type: 'POOL_STATE',
          refreshIntervalMs: 400
        });
        seenDynamic.add(leg.poolId);
      }

      if (pool.dex === 'ORCA_WHIRLPOOL') {
        const tickDesc = `${leg.poolId}:ORCA_TICK_ARRAYS_DYNAMIC`;
        if (!seenDynamic.has(tickDesc)) {
          dynamicDeps.push({
            addressType: 'UNRESOLVED_DESCRIPTOR',
            descriptor: 'ORCA_TICK_ARRAYS_DYNAMIC',
            isResolved: false,
            role: 'TICK_ARRAY',
            type: 'TICK_ARRAY',
            refreshIntervalMs: 400
          });
          seenDynamic.add(tickDesc);
        }
      } else if (pool.dex === 'RAYDIUM_AMM') {
        const vaultDesc = `${leg.poolId}:RAYDIUM_VAULT_RESERVES_DYNAMIC`;
        if (!seenDynamic.has(vaultDesc)) {
          dynamicDeps.push({
            addressType: 'UNRESOLVED_DESCRIPTOR',
            descriptor: 'RAYDIUM_VAULT_RESERVES_DYNAMIC',
            isResolved: false,
            role: 'TOKEN_VAULT_A',
            type: 'VAULT_RESERVE',
            refreshIntervalMs: 400
          });
          seenDynamic.add(vaultDesc);
        }
        const openOrdersDesc = `${leg.poolId}:RAYDIUM_OPEN_ORDERS_DYNAMIC`;
        if (!seenDynamic.has(openOrdersDesc)) {
          dynamicDeps.push({
            addressType: 'UNRESOLVED_DESCRIPTOR',
            descriptor: 'RAYDIUM_OPEN_ORDERS_DYNAMIC',
            isResolved: false,
            role: 'OPEN_ORDERS',
            type: 'OPEN_ORDERS',
            refreshIntervalMs: 400
          });
          seenDynamic.add(openOrdersDesc);
        }
      }
    }

    return { staticDependencies: staticDeps, dynamicDependencies: dynamicDeps };
  }

  public create2LegRoute(poolA: PoolConfig, poolB: PoolConfig, tokenA: string): IndexedDirectedRoute | null {
    if (poolA.id === poolB.id) return null;

    const isDirectA = this.isPoolVerifiedDirect(poolA);
    const isDirectB = this.isPoolVerifiedDirect(poolB);
    const isDirectToDirect = isDirectA && isDirectB;
    const isIntraDex = poolA.dex === poolB.dex;

    let priority = 0;
    if (isDirectToDirect) priority += 1000;
    else if (isDirectA || isDirectB) priority += 500;
    if (isIntraDex) priority += 200; // Intra-DEX has lower cross-program overhead

    priority += Math.min(
      500,
      Math.floor(((poolA.initialLiquidityUsd || 0) + (poolB.initialLiquidityUsd || 0)) / 100000)
    );

    const estAccounts = 3 + this.estimateLegAccounts(poolA.dex) + this.estimateLegAccounts(poolB.dex);
    const estCU = this.estimateLegComputeUnits(poolA.dex) + this.estimateLegComputeUnits(poolB.dex);

    // Fail closed if transaction limits exceeded
    if (estAccounts > 64 || estCU > 1400000) return null;

    const leg1 = { poolId: poolA.id, dex: poolA.dex, inputMint: CANONICAL_USDC_MINT, outputMint: tokenA };
    const leg2 = { poolId: poolB.id, dex: poolB.dex, inputMint: tokenA, outputMint: CANONICAL_USDC_MINT };
    const deps = this.buildDependenciesForLegs([leg1, leg2]);

    const routeLastVerified = isDirectToDirect
      ? Math.min(poolA.lastVerifiedAt || 0, poolB.lastVerifiedAt || 0)
      : 0;

    return {
      routeId: `${poolA.id}->${poolB.id}`,
      cycleType: '2_LEG',
      isIntraDex,
      isDirectToDirect,
      priorityScore: priority,
      legs: [leg1, leg2],
      poolIds: [poolA.id, poolB.id],
      poolAId: poolA.id,
      poolBId: poolB.id,
      dexA: poolA.dex,
      dexB: poolB.dex,
      inputMint: CANONICAL_USDC_MINT,
      intermediateMint: tokenA,
      outputMint: CANONICAL_USDC_MINT,
      estimatedAccounts: estAccounts,
      estimatedComputeUnits: estCU,
      state: isDirectToDirect ? 'VERIFIED' : 'BLOCKED',
      staticDependencies: deps.staticDependencies,
      dynamicDependencies: deps.dynamicDependencies,
      protocolAdapterVersion: '1.4.0',
      lastVerifiedAt: routeLastVerified,
      isUnprofitablePreserved: true
    };
  }

  public create3LegRoute(p1: PoolConfig, p2: PoolConfig, p3: PoolConfig, tokenA: string, tokenB: string): IndexedDirectedRoute | null {
    // Prevent repeated pool in the same atomic cycle
    if (p1.id === p2.id || p2.id === p3.id || p1.id === p3.id) return null;

    const isDirect1 = this.isPoolVerifiedDirect(p1);
    const isDirect2 = this.isPoolVerifiedDirect(p2);
    const isDirect3 = this.isPoolVerifiedDirect(p3);
    const isDirectToDirect = isDirect1 && isDirect2 && isDirect3;
    const isIntraDex = p1.dex === p2.dex && p2.dex === p3.dex;

    let priority = 100;
    if (isDirectToDirect) priority += 800;
    if (isIntraDex) priority += 150;

    const estAccounts = 3 + this.estimateLegAccounts(p1.dex) + this.estimateLegAccounts(p2.dex) + this.estimateLegAccounts(p3.dex);
    const estCU = this.estimateLegComputeUnits(p1.dex) + this.estimateLegComputeUnits(p2.dex) + this.estimateLegComputeUnits(p3.dex);

    // Fail closed if transaction limits exceeded
    if (estAccounts > 64 || estCU > 1400000) return null;

    const leg1 = { poolId: p1.id, dex: p1.dex, inputMint: CANONICAL_USDC_MINT, outputMint: tokenA };
    const leg2 = { poolId: p2.id, dex: p2.dex, inputMint: tokenA, outputMint: tokenB };
    const leg3 = { poolId: p3.id, dex: p3.dex, inputMint: tokenB, outputMint: CANONICAL_USDC_MINT };
    const deps = this.buildDependenciesForLegs([leg1, leg2, leg3]);

    const routeLastVerified = isDirectToDirect
      ? Math.min(p1.lastVerifiedAt || 0, p2.lastVerifiedAt || 0, p3.lastVerifiedAt || 0)
      : 0;

    return {
      routeId: `${p1.id}->${p2.id}->${p3.id}`,
      cycleType: '3_LEG',
      isIntraDex,
      isDirectToDirect,
      priorityScore: priority,
      legs: [leg1, leg2, leg3],
      poolIds: [p1.id, p2.id, p3.id],
      poolAId: p1.id,
      poolBId: p2.id,
      poolCId: p3.id,
      dexA: p1.dex,
      dexB: p2.dex,
      dexC: p3.dex,
      inputMint: CANONICAL_USDC_MINT,
      intermediateMint: tokenA,
      tokenBMint: tokenB,
      outputMint: CANONICAL_USDC_MINT,
      estimatedAccounts: estAccounts,
      estimatedComputeUnits: estCU,
      state: isDirectToDirect ? 'VERIFIED' : 'BLOCKED',
      staticDependencies: deps.staticDependencies,
      dynamicDependencies: deps.dynamicDependencies,
      protocolAdapterVersion: '1.4.0',
      lastVerifiedAt: routeLastVerified,
      isUnprofitablePreserved: true
    };
  }

  /**
   * Hot-activates a new pool by generating only new non-duplicate 2-leg and 3-leg cycles
   * involving that pool, updating indices without a full graph rebuild on the Sniper hot path.
   */
  public addPoolAndGenerateRoutes(pool: PoolConfig): IndexedDirectedRoute[] {
    this.poolConfigs.set(pool.id, { ...pool });

    if (!this.tokenToPools.has(pool.tokenAMint)) {
      this.tokenToPools.set(pool.tokenAMint, []);
    }
    if (!this.tokenToPools.get(pool.tokenAMint)!.some(p => p.id === pool.id)) {
      this.tokenToPools.get(pool.tokenAMint)!.push(pool);
    }

    if (!this.tokenToPools.has(pool.tokenBMint)) {
      this.tokenToPools.set(pool.tokenBMint, []);
    }
    if (!this.tokenToPools.get(pool.tokenBMint)!.some(p => p.id === pool.id)) {
      this.tokenToPools.get(pool.tokenBMint)!.push(pool);
    }

    const newRoutes: IndexedDirectedRoute[] = [];
    const intermediateTokens = [CANONICAL_WSOL_MINT, CANONICAL_USDT_MINT];
    const allPools = Array.from(this.poolConfigs.values());

    // 1. Build 2-Leg Cycles involving this new pool
    for (const tokenA of intermediateTokens) {
      if (this.poolTradesTokens(pool, CANONICAL_USDC_MINT, tokenA)) {
        for (const other of allPools) {
          if (other.id === pool.id) continue;
          if (!this.poolTradesTokens(other, CANONICAL_USDC_MINT, tokenA)) continue;

          // pool -> other
          const id1 = `${pool.id}->${other.id}`;
          if (!this.routeById.has(id1)) {
            const r1 = this.create2LegRoute(pool, other, tokenA);
            if (r1) {
              this.routeById.set(id1, r1);
              this.allRoutes.push(r1);
              this.mapPoolToRoute(pool.id, r1);
              this.mapPoolToRoute(other.id, r1);
              newRoutes.push(r1);
            }
          }

          // other -> pool
          const id2 = `${other.id}->${pool.id}`;
          if (!this.routeById.has(id2)) {
            const r2 = this.create2LegRoute(other, pool, tokenA);
            if (r2) {
              this.routeById.set(id2, r2);
              this.allRoutes.push(r2);
              this.mapPoolToRoute(other.id, r2);
              this.mapPoolToRoute(pool.id, r2);
              newRoutes.push(r2);
            }
          }
        }
      }
    }

    // 2. Build 3-Leg Cycles involving this new pool
    const threeLegPatterns = [
      { tokenA: CANONICAL_WSOL_MINT, tokenB: CANONICAL_USDT_MINT },
      { tokenA: CANONICAL_USDT_MINT, tokenB: CANONICAL_WSOL_MINT }
    ];

    for (const pattern of threeLegPatterns) {
      // Leg 1: pool is (USDC, tokenA)
      if (this.poolTradesTokens(pool, CANONICAL_USDC_MINT, pattern.tokenA)) {
        for (const p2 of allPools) {
          if (p2.id === pool.id || !this.poolTradesTokens(p2, pattern.tokenA, pattern.tokenB)) continue;
          for (const p3 of allPools) {
            if (p3.id === pool.id || p3.id === p2.id || !this.poolTradesTokens(p3, pattern.tokenB, CANONICAL_USDC_MINT)) continue;
            const rId = `${pool.id}->${p2.id}->${p3.id}`;
            if (!this.routeById.has(rId)) {
              const r = this.create3LegRoute(pool, p2, p3, pattern.tokenA, pattern.tokenB);
              if (r) {
                this.routeById.set(rId, r);
                this.allRoutes.push(r);
                this.mapPoolToRoute(pool.id, r);
                this.mapPoolToRoute(p2.id, r);
                this.mapPoolToRoute(p3.id, r);
                newRoutes.push(r);
              }
            }
          }
        }
      }

      // Leg 2: pool is (tokenA, tokenB)
      if (this.poolTradesTokens(pool, pattern.tokenA, pattern.tokenB)) {
        for (const p1 of allPools) {
          if (p1.id === pool.id || !this.poolTradesTokens(p1, CANONICAL_USDC_MINT, pattern.tokenA)) continue;
          for (const p3 of allPools) {
            if (p3.id === pool.id || p3.id === p1.id || !this.poolTradesTokens(p3, pattern.tokenB, CANONICAL_USDC_MINT)) continue;
            const rId = `${p1.id}->${pool.id}->${p3.id}`;
            if (!this.routeById.has(rId)) {
              const r = this.create3LegRoute(p1, pool, p3, pattern.tokenA, pattern.tokenB);
              if (r) {
                this.routeById.set(rId, r);
                this.allRoutes.push(r);
                this.mapPoolToRoute(p1.id, r);
                this.mapPoolToRoute(pool.id, r);
                this.mapPoolToRoute(p3.id, r);
                newRoutes.push(r);
              }
            }
          }
        }
      }

      // Leg 3: pool is (tokenB, USDC)
      if (this.poolTradesTokens(pool, pattern.tokenB, CANONICAL_USDC_MINT)) {
        for (const p1 of allPools) {
          if (p1.id === pool.id || !this.poolTradesTokens(p1, CANONICAL_USDC_MINT, pattern.tokenA)) continue;
          for (const p2 of allPools) {
            if (p2.id === pool.id || p2.id === p1.id || !this.poolTradesTokens(p2, pattern.tokenA, pattern.tokenB)) continue;
            const rId = `${p1.id}->${p2.id}->${pool.id}`;
            if (!this.routeById.has(rId)) {
              const r = this.create3LegRoute(p1, p2, pool, pattern.tokenA, pattern.tokenB);
              if (r) {
                this.routeById.set(rId, r);
                this.allRoutes.push(r);
                this.mapPoolToRoute(p1.id, r);
                this.mapPoolToRoute(p2.id, r);
                this.mapPoolToRoute(pool.id, r);
                newRoutes.push(r);
              }
            }
          }
        }
      }
    }

    if (newRoutes.length > 0) {
      this.allRoutes.sort((a, b) => b.priorityScore - a.priorityScore);
    }

    return newRoutes;
  }

  private buildIndices(pools: PoolConfig[]): void {
    for (const p of pools) {
      this.poolConfigs.set(p.id, { ...p });
    }

    // 1. Build Token-to-Pool index for allowlisted tokens
    for (const pool of pools) {
      if (!ALLOWLISTED_MINTS.has(pool.tokenAMint) && !ALLOWLISTED_MINTS.has(pool.tokenBMint)) {
        continue;
      }

      if (!this.tokenToPools.has(pool.tokenAMint)) {
        this.tokenToPools.set(pool.tokenAMint, []);
      }
      this.tokenToPools.get(pool.tokenAMint)!.push(pool);

      if (!this.tokenToPools.has(pool.tokenBMint)) {
        this.tokenToPools.set(pool.tokenBMint, []);
      }
      this.tokenToPools.get(pool.tokenBMint)!.push(pool);
    }

    // 2. Build 2-Leg Cycles: USDC -> Token A -> USDC (Inter-DEX and Intra-DEX)
    const intermediateTokens = [CANONICAL_WSOL_MINT, CANONICAL_USDT_MINT];

    for (const tokenA of intermediateTokens) {
      const candidatePools = pools.filter(p => this.poolTradesTokens(p, CANONICAL_USDC_MINT, tokenA));

      for (let i = 0; i < candidatePools.length; i++) {
        for (let j = 0; j < candidatePools.length; j++) {
          if (i === j) continue;
          const poolA = candidatePools[i];
          const poolB = candidatePools[j];

          const route = this.create2LegRoute(poolA, poolB, tokenA);
          if (route) {
            this.allRoutes.push(route);
            this.routeById.set(route.routeId, route);
            this.mapPoolToRoute(poolA.id, route);
            this.mapPoolToRoute(poolB.id, route);
          }
        }
      }
    }

    // 3. Build 3-Leg Cycles: USDC -> Token A -> Token B -> USDC
    // Cycle Pattern 1: USDC -> WSOL -> USDT -> USDC
    // Cycle Pattern 2: USDC -> USDT -> WSOL -> USDC
    const threeLegPatterns = [
      { tokenA: CANONICAL_WSOL_MINT, tokenB: CANONICAL_USDT_MINT },
      { tokenA: CANONICAL_USDT_MINT, tokenB: CANONICAL_WSOL_MINT }
    ];

    for (const pattern of threeLegPatterns) {
      const poolsLeg1 = pools.filter(p => this.poolTradesTokens(p, CANONICAL_USDC_MINT, pattern.tokenA));
      const poolsLeg2 = pools.filter(p => this.poolTradesTokens(p, pattern.tokenA, pattern.tokenB));
      const poolsLeg3 = pools.filter(p => this.poolTradesTokens(p, pattern.tokenB, CANONICAL_USDC_MINT));

      for (const p1 of poolsLeg1) {
        for (const p2 of poolsLeg2) {
          for (const p3 of poolsLeg3) {
            const route = this.create3LegRoute(p1, p2, p3, pattern.tokenA, pattern.tokenB);
            if (route) {
              this.allRoutes.push(route);
              this.routeById.set(route.routeId, route);
              this.mapPoolToRoute(p1.id, route);
              this.mapPoolToRoute(p2.id, route);
              this.mapPoolToRoute(p3.id, route);
            }
          }
        }
      }
    }

    // Sort routes by priority score descending
    this.allRoutes.sort((a, b) => b.priorityScore - a.priorityScore);
  }

  private mapPoolToRoute(poolId: string, route: IndexedDirectedRoute): void {
    if (!this.poolToRoutes.has(poolId)) {
      this.poolToRoutes.set(poolId, []);
    }
    this.poolToRoutes.get(poolId)!.push(route);
  }

  public getPoolsByToken(tokenMint: string): PoolConfig[] {
    return this.tokenToPools.get(tokenMint) || [];
  }

  public getRoutesAffectedByPool(poolId: string, onlyEligible: boolean = false): IndexedDirectedRoute[] {
    const routes = this.poolToRoutes.get(poolId) || [];
    if (onlyEligible) {
      return routes.filter(r => r.state !== 'BLOCKED');
    }
    return routes;
  }

  public getAllRoutes(): IndexedDirectedRoute[] {
    return this.allRoutes;
  }

  public getRouteCount(): number {
    return this.allRoutes.length;
  }

  public getTwoLegRouteCount(): number {
    return this.allRoutes.filter(r => r.cycleType === '2_LEG').length;
  }

  public getThreeLegRouteCount(): number {
    return this.allRoutes.filter(r => r.cycleType === '3_LEG').length;
  }

  public getIntraDexRouteCount(): number {
    return this.allRoutes.filter(r => r.isIntraDex).length;
  }

  public getInterDexRouteCount(): number {
    return this.allRoutes.filter(r => !r.isIntraDex).length;
  }

  public getVerifiedDirectRoutes(): IndexedDirectedRoute[] {
    return this.allRoutes.filter(r => r.isDirectToDirect);
  }

  public getBlockedRoutes(): IndexedDirectedRoute[] {
    return this.allRoutes.filter(r => !r.isDirectToDirect);
  }

  public getVerifiedDirectRouteCount(): number {
    return this.allRoutes.filter(r => r.isDirectToDirect).length;
  }

  public getBlockedRouteCount(): number {
    return this.allRoutes.filter(r => !r.isDirectToDirect).length;
  }

  public getRouteById(routeId: string): IndexedDirectedRoute | undefined {
    return this.routeById.get(routeId);
  }

  public getReadyRoutes(): IndexedDirectedRoute[] {
    return this.allRoutes.filter(r => r.state === 'READY');
  }

  public getReadyRouteCount(): number {
    return this.allRoutes.filter(r => r.state === 'READY').length;
  }

  public getVerifiedRoutes(): IndexedDirectedRoute[] {
    return this.allRoutes.filter(r => r.state === 'VERIFIED' || r.state === 'READY' || r.state === 'STALE');
  }

  public getVerifiedRouteCount(): number {
    return this.allRoutes.filter(r => r.state === 'VERIFIED' || r.state === 'READY' || r.state === 'STALE').length;
  }

  public getStaleRouteCount(): number {
    return this.allRoutes.filter(r => r.state === 'STALE').length;
  }

  public getRouteCountByState(state: RouteState): number {
    return this.allRoutes.filter(r => r.state === state).length;
  }

  public getRoutesByState(state: RouteState): IndexedDirectedRoute[] {
    return this.allRoutes.filter(r => r.state === state);
  }

  public getLifecycleTransitionStats(): {
    readyToStaleTransitions: number;
    staleToReadyRecoveries: number;
    peakReadyCount: number;
  } {
    return {
      readyToStaleTransitions: this.readyToStaleTransitions,
      staleToReadyRecoveries: this.staleToReadyRecoveries,
      peakReadyCount: this.peakReadyCount
    };
  }

  public setRouteReady(routeId: string, quoteStats?: { expectedNetUSDC: string; timestamp: number }): boolean {
    const route = this.routeById.get(routeId);
    if (!route || !route.isDirectToDirect || route.state === 'BLOCKED') {
      return false;
    }

    const prevState = route.state;
    route.state = 'READY';
    if (prevState !== 'READY') {
      route.lastBecameReadyAt = Date.now();
    }
    if (prevState === 'STALE') {
      this.staleToReadyRecoveries++;
    }
    const currentReady = this.getReadyRouteCount();
    if (currentReady > this.peakReadyCount) {
      this.peakReadyCount = currentReady;
    }

    if (quoteStats) {
      route.lastQuoteExpectedNetUSDC = quoteStats.expectedNetUSDC;
      route.lastQuoteTimestamp = quoteStats.timestamp;
    }
    return true;
  }

  public setRouteStale(routeId: string, reason?: string): boolean {
    const route = this.routeById.get(routeId);
    if (!route || !route.isDirectToDirect || route.state === 'BLOCKED') {
      return false;
    }

    if (route.state === 'READY') {
      this.readyToStaleTransitions++;
      if (route.lastBecameReadyAt) {
        route.readyDurationMs = (route.readyDurationMs || 0) + (Date.now() - route.lastBecameReadyAt);
        route.lastBecameReadyAt = undefined;
      }
    }

    // Transitory freshness loss: transitions READY or VERIFIED -> STALE.
    // Crucial: do not mark structurally valid routes as BLOCKED!
    route.state = 'STALE';
    if (reason) {
      route.verificationDetails = reason;
    }
    return true;
  }

  /**
   * Restores a STALE route to READY only after validating that all dependency pool states
   * exist, have valid required timestamp, slot, and healthy feed evidence.
   * Missing, invalid, expired, or lagging evidence strictly fails closed.
   */
  public validateAndRestoreRoute(
    routeId: string,
    getPoolState: (poolId: string) => { receivedAt?: number; slot?: number; feedHealth?: string } | undefined,
    maxSlotAgeMs: number = 5000,
    maxSlotGap: number = 20,
    currentSlot?: number
  ): boolean {
    const route = this.routeById.get(routeId);
    if (!route || !route.isDirectToDirect || route.state === 'BLOCKED') {
      return false;
    }

    const now = Date.now();
    let minSlot = Infinity;
    let maxSlot = -Infinity;

    for (const leg of route.legs) {
      const poolState = getPoolState(leg.poolId);
      if (!poolState) {
        route.state = 'STALE';
        route.verificationDetails = `MISSING_DEPENDENCY_STATE:${leg.poolId}`;
        return false;
      }

      // FIX 3: Required timestamp evidence must be present, valid, non-future, and non-expired
      if (typeof poolState.receivedAt !== 'number' || poolState.receivedAt <= 0 || isNaN(poolState.receivedAt)) {
        route.state = 'STALE';
        route.verificationDetails = `MISSING_TIMESTAMP_EVIDENCE:${leg.poolId}`;
        return false;
      }
      if (poolState.receivedAt > now + 5000) {
        route.state = 'STALE';
        route.verificationDetails = `FUTURE_TIMESTAMP:${leg.poolId}`;
        return false;
      }
      if (now - poolState.receivedAt > maxSlotAgeMs) {
        route.state = 'STALE';
        route.verificationDetails = `EXPIRED_DEPENDENCY_STATE:${leg.poolId}`;
        return false;
      }

      // FIX 3: Required slot evidence must be present, valid, non-future, and non-lagging
      if (typeof poolState.slot !== 'number' || poolState.slot <= 0 || isNaN(poolState.slot)) {
        route.state = 'STALE';
        route.verificationDetails = `MISSING_SLOT_EVIDENCE:${leg.poolId}`;
        return false;
      }
      if (currentSlot !== undefined && poolState.slot > currentSlot + 10) {
        route.state = 'STALE';
        route.verificationDetails = `FUTURE_SLOT:${leg.poolId}`;
        return false;
      }
      if (currentSlot !== undefined && currentSlot - poolState.slot > maxSlotGap) {
        route.state = 'STALE';
        route.verificationDetails = `EXCESSIVE_SLOT_LAG:${leg.poolId}`;
        return false;
      }

      // FIX 3: Required feed-health evidence must be present and HEALTHY
      if (!poolState.feedHealth || typeof poolState.feedHealth !== 'string' || poolState.feedHealth !== 'HEALTHY') {
        route.state = 'STALE';
        route.verificationDetails = `MISSING_OR_UNHEALTHY_FEED_EVIDENCE:${leg.poolId}`;
        return false;
      }

      if (poolState.slot < minSlot) minSlot = poolState.slot;
      if (poolState.slot > maxSlot) maxSlot = poolState.slot;
    }

    // Inter-pool slot gap check
    if (maxSlot !== -Infinity && minSlot !== Infinity && (maxSlot - minSlot > maxSlotGap)) {
      route.state = 'STALE';
      route.verificationDetails = `SLOT_GAP_EXCEEDED:${maxSlot - minSlot} > ${maxSlotGap}`;
      return false;
    }

    // Dependencies verified fresh -> restore to READY
    const prevState = route.state;
    route.state = 'READY';
    if (prevState === 'STALE') {
      this.staleToReadyRecoveries++;
    }
    const currentReady = this.getReadyRouteCount();
    if (currentReady > this.peakReadyCount) {
      this.peakReadyCount = currentReady;
    }
    return true;
  }

  /**
   * FIX 1: Expire READY routes when required live data, quote age, feed health, or slot limits become stale.
   * Uses existing scanner configuration (maxSlotAgeMs / maxSlotGap / currentSlot).
   */
  public expireStaleReadyRoutes(
    getPoolState: (poolId: string) => { receivedAt?: number; slot?: number; feedHealth?: string } | undefined,
    maxSlotAgeMs: number = 2500,
    maxSlotGap: number = 10,
    currentSlot?: number
  ): IndexedDirectedRoute[] {
    const expired: IndexedDirectedRoute[] = [];
    const now = Date.now();

    for (const route of this.allRoutes) {
      if (route.state !== 'READY') continue;

      let isExpired = false;
      let expireReason = '';

      // Check route's own quote timestamp freshness using existing maxSlotAgeMs / MAX_QUOTE_AGE_MS
      if (route.lastQuoteTimestamp && (now - route.lastQuoteTimestamp > maxSlotAgeMs)) {
        isExpired = true;
        expireReason = `EXPIRED_QUOTE:${now - route.lastQuoteTimestamp}ms > ${maxSlotAgeMs}ms`;
      }

      if (!isExpired) {
        let minSlot = Infinity;
        let maxSlot = -Infinity;

        for (const leg of route.legs) {
          const poolState = getPoolState(leg.poolId);
          if (!poolState) {
            isExpired = true;
            expireReason = `MISSING_DEPENDENCY_STATE:${leg.poolId}`;
            break;
          }
          if (typeof poolState.receivedAt !== 'number' || poolState.receivedAt <= 0 || isNaN(poolState.receivedAt)) {
            isExpired = true;
            expireReason = `MISSING_TIMESTAMP_EVIDENCE:${leg.poolId}`;
            break;
          }
          if (poolState.receivedAt > now + 5000) {
            isExpired = true;
            expireReason = `FUTURE_TIMESTAMP:${leg.poolId}`;
            break;
          }
          if (now - poolState.receivedAt > maxSlotAgeMs) {
            isExpired = true;
            expireReason = `EXPIRED_DEPENDENCY_STATE:${leg.poolId}`;
            break;
          }
          if (typeof poolState.slot !== 'number' || poolState.slot <= 0 || isNaN(poolState.slot)) {
            isExpired = true;
            expireReason = `MISSING_SLOT_EVIDENCE:${leg.poolId}`;
            break;
          }
          if (currentSlot !== undefined && poolState.slot > currentSlot + 10) {
            isExpired = true;
            expireReason = `FUTURE_SLOT:${leg.poolId}`;
            break;
          }
          if (currentSlot !== undefined && currentSlot - poolState.slot > maxSlotGap) {
            isExpired = true;
            expireReason = `EXCESSIVE_SLOT_LAG:${leg.poolId}`;
            break;
          }
          if (!poolState.feedHealth || typeof poolState.feedHealth !== 'string' || poolState.feedHealth !== 'HEALTHY') {
            isExpired = true;
            expireReason = `MISSING_OR_UNHEALTHY_FEED_EVIDENCE:${leg.poolId}`;
            break;
          }

          if (poolState.slot < minSlot) minSlot = poolState.slot;
          if (poolState.slot > maxSlot) maxSlot = poolState.slot;
        }

        if (!isExpired && maxSlot !== -Infinity && minSlot !== Infinity && (maxSlot - minSlot > maxSlotGap)) {
          isExpired = true;
          expireReason = `SLOT_GAP_EXCEEDED:${maxSlot - minSlot} > ${maxSlotGap}`;
        }
      }

      if (isExpired) {
        route.state = 'STALE';
        this.readyToStaleTransitions++;
        if (route.lastBecameReadyAt) {
          route.readyDurationMs = (route.readyDurationMs || 0) + (now - route.lastBecameReadyAt);
          route.lastBecameReadyAt = undefined;
        }
        route.verificationDetails = expireReason;
        expired.push(route);
      }
    }

    return expired;
  }

  /**
   * Reconciles saved routes from SQLite into the active RouteIndex.
   * Saved routes must pass current pool and adapter verification before becoming eligible for live quoting.
   */
  public reconcilePersistentRoutes(savedRoutes: PermanentRouteRecord[]): { recovered: number; blocked: number; updated: number } {
    let recovered = 0;
    let blocked = 0;
    let updated = 0;

    for (const saved of savedRoutes) {
      // 1. Verify every pool exists in current PoolRegistry configs
      const poolsExist = saved.orderedPoolIds.every(id => this.poolConfigs.has(id));
      if (!poolsExist) {
        blocked++;
        continue;
      }

      // 2. Verify all pools are VERIFIED_DIRECT
      const allDirect = saved.orderedPoolIds.every(id => {
        const pool = this.poolConfigs.get(id);
        return pool && this.isPoolVerifiedDirect(pool);
      });

      // Saved routes never start as READY upon restart; they start as VERIFIED or BLOCKED
      const targetState: RouteState = allDirect ? 'VERIFIED' : 'BLOCKED';

      const existing = this.routeById.get(saved.routeId);
      if (existing) {
        existing.state = targetState;
        existing.isDirectToDirect = allDirect;
        existing.isUnprofitablePreserved = saved.isUnprofitablePreserved !== false;
        existing.lastQuoteExpectedNetUSDC = saved.lastQuoteExpectedNetUSDC;
        existing.lastQuoteTimestamp = saved.lastQuoteTimestamp;
        if (saved.lastVerifiedAt) existing.lastVerifiedAt = saved.lastVerifiedAt;
        updated++;
      } else {
        // Reconstruct from saved record
        const legs: RouteLegInfo[] = [];
        for (let i = 0; i < saved.orderedPoolIds.length; i++) {
          const poolId = saved.orderedPoolIds[i];
          const pool = this.poolConfigs.get(poolId)!;
          const inputMint = saved.orderedTokens[i];
          const outputMint = saved.orderedTokens[i + 1] || saved.orderedTokens[0];
          legs.push({ poolId, dex: pool.dex, inputMint, outputMint });
        }

        const poolA = this.poolConfigs.get(legs[0].poolId)!;
        const poolB = this.poolConfigs.get(legs[1].poolId)!;
        const poolC = legs[2] ? this.poolConfigs.get(legs[2].poolId) : undefined;

        let priority = 0;
        if (allDirect) priority += (saved.cycleType === '3_LEG' ? 800 : 1000);
        if (saved.isIntraDex) priority += (saved.cycleType === '3_LEG' ? 150 : 200);

        const newRoute: IndexedDirectedRoute = {
          routeId: saved.routeId,
          cycleType: saved.cycleType,
          isIntraDex: saved.isIntraDex,
          isDirectToDirect: allDirect,
          priorityScore: priority,
          legs,
          poolIds: [...saved.orderedPoolIds],
          poolAId: poolA.id,
          poolBId: poolB.id,
          poolCId: poolC?.id,
          dexA: poolA.dex,
          dexB: poolB.dex,
          dexC: poolC?.dex,
          inputMint: legs[0].inputMint,
          intermediateMint: legs[0].outputMint,
          tokenBMint: legs[2] ? legs[1].outputMint : undefined,
          outputMint: legs[legs.length - 1].outputMint,
          estimatedAccounts: saved.estimatedAccounts,
          estimatedComputeUnits: saved.estimatedComputeUnits,
          state: targetState,
          staticDependencies: saved.staticDependencies,
          dynamicDependencies: saved.dynamicDependencies,
          protocolAdapterVersion: saved.protocolAdapterVersion || '1.4.0',
          lastVerifiedAt: saved.lastVerifiedAt || 0,
          isUnprofitablePreserved: saved.isUnprofitablePreserved !== false,
          lastQuoteExpectedNetUSDC: saved.lastQuoteExpectedNetUSDC,
          lastQuoteTimestamp: saved.lastQuoteTimestamp,
          verificationDetails: saved.verificationDetails
        };

        this.allRoutes.push(newRoute);
        this.routeById.set(newRoute.routeId, newRoute);
        for (const pid of saved.orderedPoolIds) {
          this.mapPoolToRoute(pid, newRoute);
        }

        if (allDirect) recovered++;
        else blocked++;
      }
    }

    this.allRoutes.sort((a, b) => b.priorityScore - a.priorityScore);
    return { recovered, blocked, updated };
  }

  public toPermanentRecord(route: IndexedDirectedRoute): PermanentRouteRecord {
    const orderedDexPrograms = route.legs.map(l => {
      const cfg = this.poolConfigs.get(l.poolId);
      return cfg?.programId || '';
    });
    const orderedTokens = [
      route.legs[0].inputMint,
      ...route.legs.map(l => l.outputMint)
    ];

    return {
      routeId: route.routeId,
      cycleType: route.cycleType,
      isIntraDex: route.isIntraDex,
      orderedPoolIds: [...route.poolIds],
      orderedDexPrograms,
      orderedTokens,
      staticDependencies: [...route.staticDependencies],
      dynamicDependencies: [...route.dynamicDependencies],
      protocolAdapterVersion: route.protocolAdapterVersion || '1.4.0',
      estimatedAccounts: route.estimatedAccounts,
      estimatedComputeUnits: route.estimatedComputeUnits,
      state: route.state,
      isUnprofitablePreserved: route.isUnprofitablePreserved !== false,
      lastQuoteExpectedNetUSDC: route.lastQuoteExpectedNetUSDC,
      lastQuoteTimestamp: route.lastQuoteTimestamp,
      verificationDetails: route.verificationDetails,
      lastVerifiedAt: route.lastVerifiedAt || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  public getAllPermanentRecords(): PermanentRouteRecord[] {
    return this.allRoutes.map(r => this.toPermanentRecord(r));
  }

  public recordReadySample(): number {
    const readyCount = this.getReadyRouteCount();
    this.readySamples.push(readyCount);
    return readyCount;
  }

  public getReadyMetricsSummary(): ReadyMetricsSummary {
    const currentReady = this.getReadyRouteCount();
    if (this.readySamples.length === 0) {
      return {
        currentReady,
        peakReady: this.peakReadyCount,
        minReady: currentReady,
        timeWeightedReadyAvg: currentReady,
        p10ReadyCount: currentReady,
        totalSamples: 0
      };
    }

    const sorted = [...this.readySamples].sort((a, b) => a - b);
    const sum = this.readySamples.reduce((acc, v) => acc + v, 0);
    const avg = Number((sum / this.readySamples.length).toFixed(2));
    const min = sorted[0];
    const p10Index = Math.max(0, Math.floor(sorted.length * 0.10));
    const p10 = sorted[p10Index];

    return {
      currentReady,
      peakReady: this.peakReadyCount,
      minReady: min,
      timeWeightedReadyAvg: avg,
      p10ReadyCount: p10,
      totalSamples: this.readySamples.length
    };
  }

  public getBottleneckBreakdown(
    getPoolState: (poolId: string) => { dex: string; reserveA?: bigint; reserveB?: bigint; extraData?: any } | undefined,
    currentSlot?: number,
    wsConnected: boolean = true
  ): RouteBottleneckBreakdown {
    const breakdown: RouteBottleneckBreakdown = {
      unverifiedPool: 0,
      unsupportedAdapter: 0,
      missingTickArrays: 0,
      missingVaultOrOpenOrders: 0,
      expiredQuote: 0,
      expiredPoolObservation: 0,
      slotMismatch: 0,
      websocketDelay: 0,
      rpcHydrationFailure: 0,
      incompletePricing: 0,
      insufficientLiquidity: 0,
      other: 0
    };

    for (const route of this.allRoutes) {
      if (route.state === 'READY') continue;

      let classified = false;

      if (!wsConnected) {
        breakdown.websocketDelay++;
        continue;
      }

      for (const leg of route.legs) {
        const poolCfg = this.poolConfigs.get(leg.poolId);
        if (!poolCfg) {
          breakdown.unverifiedPool++;
          classified = true;
          break;
        }

        if (
          poolCfg.dex === 'RAYDIUM_CLMM' ||
          poolCfg.dex === 'PHOENIX' ||
          poolCfg.blockerReason === 'UNSUPPORTED_PRICING_ADAPTER_CLMM' ||
          poolCfg.blockerReason === 'PENDING_ORDERBOOK_STREAMING'
        ) {
          breakdown.unsupportedAdapter++;
          classified = true;
          break;
        }

        if (poolCfg.blockerReason === 'RPC_TIMEOUT' || poolCfg.blockerReason === 'ACCOUNT_NOT_FOUND') {
          breakdown.rpcHydrationFailure++;
          classified = true;
          break;
        }

        if (poolCfg.verificationStatus !== 'VERIFIED_DIRECT') {
          if (poolCfg.blockerReason === 'MISSING_TICK_DATA') {
            breakdown.missingTickArrays++;
          } else if (
            poolCfg.blockerReason === 'UNHYDRATED_VAULTS' ||
            poolCfg.blockerReason === 'RAYDIUM_AMM_V4_ADAPTER_PENDING' ||
            poolCfg.blockerReason === 'OPENORDERS_LAYOUT_INVALID' ||
            poolCfg.blockerReason === 'MISSING_VAULT_METADATA'
          ) {
            breakdown.missingVaultOrOpenOrders++;
          } else {
            breakdown.unverifiedPool++;
          }
          classified = true;
          break;
        }

        const poolState = getPoolState(leg.poolId);
        if (!poolState) {
          breakdown.rpcHydrationFailure++;
          classified = true;
          break;
        }

        if (poolState.dex === 'RAYDIUM_AMM') {
          if ((poolState.reserveA ?? 0n) <= 0n || (poolState.reserveB ?? 0n) <= 0n) {
            breakdown.insufficientLiquidity++;
            classified = true;
            break;
          }
        }

        if (poolState.dex === 'ORCA_WHIRLPOOL') {
          const extra = poolState.extraData as any;
          if (!extra?.tickArrays || Object.keys(extra.tickArrays).length === 0) {
            breakdown.missingTickArrays++;
            classified = true;
            break;
          }
        }
      }

      if (!classified) {
        if (route.state === 'STALE') {
          const details = route.verificationDetails || '';
          if (details.includes('EXPIRED_QUOTE')) {
            breakdown.expiredQuote++;
          } else if (
            details.includes('EXPIRED_DEPENDENCY_STATE') ||
            details.includes('STALE_QUOTE') ||
            details.includes('STALE_VAULT_SNAPSHOT')
          ) {
            breakdown.expiredPoolObservation++;
          } else if (
            details.includes('SLOT_MISMATCH') ||
            details.includes('EXCESSIVE_SLOT_LAG') ||
            details.includes('SLOT_GAP_EXCEEDED')
          ) {
            breakdown.slotMismatch++;
          } else if (details.includes('WS_DISCONNECTED')) {
            breakdown.websocketDelay++;
          } else {
            breakdown.other++;
          }
        } else {
          breakdown.other++;
        }
      }
    }

    return breakdown;
  }

  public getQuoteAgeDistribution(now: number = Date.now()): QuoteAgeDistribution {
    const dist: QuoteAgeDistribution = {
      under500ms: 0,
      from500to1000ms: 0,
      from1000to2000ms: 0,
      from2000to2500ms: 0,
      over2500ms: 0
    };

    for (const route of this.allRoutes) {
      if (!route.lastQuoteTimestamp) continue;
      const age = now - route.lastQuoteTimestamp;
      if (age < 500) dist.under500ms++;
      else if (age < 1000) dist.from500to1000ms++;
      else if (age < 2000) dist.from1000to2000ms++;
      else if (age <= 2500) dist.from2000to2500ms++;
      else dist.over2500ms++;
    }

    return dist;
  }

  public getSlotLagDistribution(
    getPoolState: (poolId: string) => { slot?: number } | undefined,
    currentSlot: number
  ): SlotLagDistribution {
    const dist: SlotLagDistribution = {
      lag0to1: 0,
      lag2to4: 0,
      lag5to7: 0,
      lag8to10: 0,
      lagOver10: 0
    };

    if (currentSlot <= 0) return dist;

    for (const route of this.allRoutes) {
      if (route.state !== 'READY' && route.state !== 'VERIFIED' && route.state !== 'STALE') continue;

      let maxLag = 0;
      for (const leg of route.legs) {
        const pool = getPoolState(leg.poolId);
        if (pool && pool.slot) {
          const lag = Math.max(0, currentSlot - pool.slot);
          if (lag > maxLag) maxLag = lag;
        }
      }

      if (maxLag <= 1) dist.lag0to1++;
      else if (maxLag <= 4) dist.lag2to4++;
      else if (maxLag <= 7) dist.lag5to7++;
      else if (maxLag <= 10) dist.lag8to10++;
      else dist.lagOver10++;
    }

    return dist;
  }

  public getRouteUptimeReport(sessionDurationMs: number): { averageUptimePercent: number; routeUptimes: RouteUptimeStats[] } {
    const now = Date.now();
    const duration = Math.max(1, sessionDurationMs);
    const uptimes: RouteUptimeStats[] = [];

    let totalPercent = 0;
    const verifiedRoutes = this.allRoutes.filter(r => r.state === 'READY' || r.state === 'STALE' || r.state === 'VERIFIED');

    for (const route of verifiedRoutes) {
      let activeMs = route.readyDurationMs || 0;
      if (route.state === 'READY' && route.lastBecameReadyAt) {
        activeMs += (now - route.lastBecameReadyAt);
      }
      const percent = Math.min(100, Number(((activeMs / duration) * 100).toFixed(2)));
      totalPercent += percent;

      uptimes.push({
        routeId: route.routeId,
        state: route.state,
        readyDurationMs: activeMs,
        uptimePercent: percent
      });
    }

    const averageUptimePercent = verifiedRoutes.length > 0 ? Number((totalPercent / verifiedRoutes.length).toFixed(2)) : 0;
    return {
      averageUptimePercent,
      routeUptimes: uptimes
    };
  }
}
