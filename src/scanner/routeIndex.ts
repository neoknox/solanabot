import { PoolConfig } from './poolRegistry.js';
import { DexType } from '../types/index.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../config/index.js';

export interface IndexedDirectedRoute {
  routeId: string;
  poolAId: string;
  poolBId: string;
  dexA: DexType;
  dexB: DexType;
  inputMint: string;
  intermediateMint: string;
  outputMint: string;
  isDirectToDirect: boolean;
  priorityScore: number;
}

export class RouteIndex {
  // Token Mint -> Pools trading this token
  private tokenToPools = new Map<string, PoolConfig[]>();

  // Pool ID -> Directed Routes where this pool is either Leg 1 or Leg 2
  private poolToRoutes = new Map<string, IndexedDirectedRoute[]>();

  // All indexed directed routes sorted by priority
  private allRoutes: IndexedDirectedRoute[] = [];

  constructor(pools: PoolConfig[]) {
    this.buildIndices(pools);
  }

  public rebuild(pools: PoolConfig[]): void {
    this.tokenToPools.clear();
    this.poolToRoutes.clear();
    this.allRoutes = [];
    this.buildIndices(pools);
  }

  private buildIndices(pools: PoolConfig[]): void {
    // 1. Build Token-to-Pool index
    for (const pool of pools) {
      if (!this.tokenToPools.has(pool.tokenAMint)) {
        this.tokenToPools.set(pool.tokenAMint, []);
      }
      this.tokenToPools.get(pool.tokenAMint)!.push(pool);

      if (!this.tokenToPools.has(pool.tokenBMint)) {
        this.tokenToPools.set(pool.tokenBMint, []);
      }
      this.tokenToPools.get(pool.tokenBMint)!.push(pool);
    }

    // 2. Build Directed 2-Hop Arbitrage Routes
    // Focus on canonical WSOL / USDC pairs
    const solUsdcPools = pools.filter(
      p =>
        (p.tokenAMint === CANONICAL_WSOL_MINT && p.tokenBMint === CANONICAL_USDC_MINT) ||
        (p.tokenAMint === CANONICAL_USDC_MINT && p.tokenBMint === CANONICAL_WSOL_MINT)
    );

    for (let i = 0; i < solUsdcPools.length; i++) {
      for (let j = 0; j < solUsdcPools.length; j++) {
        if (i === j) continue;
        const poolA = solUsdcPools[i];
        const poolB = solUsdcPools[j];

        const isDirectA = poolA.dex === 'RAYDIUM_AMM' || poolA.dex === 'ORCA_WHIRLPOOL' || poolA.dex === 'METEORA_DLMM';
        const isDirectB = poolB.dex === 'RAYDIUM_AMM' || poolB.dex === 'ORCA_WHIRLPOOL' || poolB.dex === 'METEORA_DLMM';

        // Direct-to-direct pool combinations get highest priority (0ms local math)
        let priority = 0;
        if (isDirectA && isDirectB) priority += 1000;
        else if (isDirectA || isDirectB) priority += 500;

        priority += Math.min(500, Math.floor(((poolA.initialLiquidityUsd || 0) + (poolB.initialLiquidityUsd || 0)) / 100000));

        const route: IndexedDirectedRoute = {
          routeId: `${poolA.id}->${poolB.id}`,
          poolAId: poolA.id,
          poolBId: poolB.id,
          dexA: poolA.dex,
          dexB: poolB.dex,
          inputMint: CANONICAL_USDC_MINT,
          intermediateMint: CANONICAL_WSOL_MINT,
          outputMint: CANONICAL_USDC_MINT,
          isDirectToDirect: isDirectA && isDirectB,
          priorityScore: priority
        };

        this.allRoutes.push(route);

        // Map Pool A -> Route
        if (!this.poolToRoutes.has(poolA.id)) {
          this.poolToRoutes.set(poolA.id, []);
        }
        this.poolToRoutes.get(poolA.id)!.push(route);

        // Map Pool B -> Route
        if (!this.poolToRoutes.has(poolB.id)) {
          this.poolToRoutes.set(poolB.id, []);
        }
        this.poolToRoutes.get(poolB.id)!.push(route);
      }
    }

    // Sort routes by priority descending
    this.allRoutes.sort((a, b) => b.priorityScore - a.priorityScore);
  }

  public getPoolsByToken(tokenMint: string): PoolConfig[] {
    return this.tokenToPools.get(tokenMint) || [];
  }

  public getRoutesAffectedByPool(poolId: string): IndexedDirectedRoute[] {
    return this.poolToRoutes.get(poolId) || [];
  }

  public getAllRoutes(): IndexedDirectedRoute[] {
    return this.allRoutes;
  }

  public getRouteCount(): number {
    return this.allRoutes.length;
  }
}
