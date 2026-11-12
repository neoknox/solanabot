import { PoolConfig } from './poolRegistry.js';
import { DexType, CycleType } from '../types/index.js';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  ALLOWLISTED_MINTS
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
}

export class RouteIndex {
  // Token Mint -> Pools trading this token
  private tokenToPools = new Map<string, PoolConfig[]>();

  // Pool ID -> Directed Routes where this pool is involved
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

  private buildIndices(pools: PoolConfig[]): void {
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
          if (estAccounts > 64 || estCU > 1400000) continue;

          const route: IndexedDirectedRoute = {
            routeId: `${poolA.id}->${poolB.id}`,
            cycleType: '2_LEG',
            isIntraDex,
            isDirectToDirect,
            priorityScore: priority,
            legs: [
              { poolId: poolA.id, dex: poolA.dex, inputMint: CANONICAL_USDC_MINT, outputMint: tokenA },
              { poolId: poolB.id, dex: poolB.dex, inputMint: tokenA, outputMint: CANONICAL_USDC_MINT }
            ],
            poolIds: [poolA.id, poolB.id],
            poolAId: poolA.id,
            poolBId: poolB.id,
            dexA: poolA.dex,
            dexB: poolB.dex,
            inputMint: CANONICAL_USDC_MINT,
            intermediateMint: tokenA,
            outputMint: CANONICAL_USDC_MINT,
            estimatedAccounts: estAccounts,
            estimatedComputeUnits: estCU
          };

          this.allRoutes.push(route);
          this.mapPoolToRoute(poolA.id, route);
          this.mapPoolToRoute(poolB.id, route);
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
            // Prevent repeated pool in the same atomic cycle
            if (p1.id === p2.id || p2.id === p3.id || p1.id === p3.id) continue;

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
            if (estAccounts > 64 || estCU > 1400000) continue;

            const route: IndexedDirectedRoute = {
              routeId: `${p1.id}->${p2.id}->${p3.id}`,
              cycleType: '3_LEG',
              isIntraDex,
              isDirectToDirect,
              priorityScore: priority,
              legs: [
                { poolId: p1.id, dex: p1.dex, inputMint: CANONICAL_USDC_MINT, outputMint: pattern.tokenA },
                { poolId: p2.id, dex: p2.dex, inputMint: pattern.tokenA, outputMint: pattern.tokenB },
                { poolId: p3.id, dex: p3.dex, inputMint: pattern.tokenB, outputMint: CANONICAL_USDC_MINT }
              ],
              poolIds: [p1.id, p2.id, p3.id],
              poolAId: p1.id,
              poolBId: p2.id,
              poolCId: p3.id,
              dexA: p1.dex,
              dexB: p2.dex,
              dexC: p3.dex,
              inputMint: CANONICAL_USDC_MINT,
              intermediateMint: pattern.tokenA,
              tokenBMint: pattern.tokenB,
              outputMint: CANONICAL_USDC_MINT,
              estimatedAccounts: estAccounts,
              estimatedComputeUnits: estCU
            };

            this.allRoutes.push(route);
            this.mapPoolToRoute(p1.id, route);
            this.mapPoolToRoute(p2.id, route);
            this.mapPoolToRoute(p3.id, route);
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

  public getRoutesAffectedByPool(poolId: string): IndexedDirectedRoute[] {
    return this.poolToRoutes.get(poolId) || [];
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
}
