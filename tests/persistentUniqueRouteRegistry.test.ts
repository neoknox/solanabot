import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { RouteIndex, IndexedDirectedRoute } from '../src/scanner/routeIndex.js';
import { PoolRegistry, PoolConfig } from '../src/scanner/poolRegistry.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { loadConfig } from '../src/config/index.js';
import {
  PermanentRouteRecord,
  VerifiedPoolRecord,
  RouteState
} from '../src/types/index.js';
import { CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT, CANONICAL_USDT_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';

describe('SOLANABOT — Persistent Unique Route Registry Suite', () => {
  let testDbPath: string;
  let config: ReturnType<typeof loadConfig>;
  let repo: ArbitrageRepository;
  let poolRegistry: PoolRegistry;

  beforeEach(() => {
    testDbPath = path.resolve(__dirname, `test_unique_route_registry_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    config = loadConfig({ DB_PATH: testDbPath });
    repo = new ArbitrageRepository(config);
    poolRegistry = new PoolRegistry();
  });

  afterEach(() => {
    if (repo) {
      try { repo.close(); } catch {}
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const p = testDbPath + suffix;
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  });

  /**
   * Helper to generate N realistic pools for testing route scaling.
   */
  function generateTestPools(count: number): PoolConfig[] {
    const pools: PoolConfig[] = [];
    const dexes: Array<'ORCA_WHIRLPOOL' | 'RAYDIUM_AMM'> = ['ORCA_WHIRLPOOL', 'RAYDIUM_AMM'];

    for (let i = 0; i < count; i++) {
      const isOrca = i % 2 === 0;
      const dex = isOrca ? 'ORCA_WHIRLPOOL' : 'RAYDIUM_AMM';
      const programId = isOrca
        ? KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL
        : KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4;

      // Group into 3 token pairs
      let tokenA = CANONICAL_USDC_MINT;
      let tokenB = CANONICAL_WSOL_MINT;
      if (i % 3 === 1) {
        tokenA = CANONICAL_WSOL_MINT;
        tokenB = CANONICAL_USDT_MINT;
      } else if (i % 3 === 2) {
        tokenA = CANONICAL_USDT_MINT;
        tokenB = CANONICAL_USDC_MINT;
      }

      const id = `test-pool-${i.toString().padStart(4, '0')}-${dex.toLowerCase()}`;
      pools.push({
        id,
        dex,
        programId,
        tokenAMint: tokenA,
        tokenBMint: tokenB,
        feeBps: 25,
        verificationStatus: isOrca ? 'VERIFIED_DIRECT' : 'QUOTE_UNVERIFIED',
        blockerReason: isOrca ? undefined : 'RAYDIUM_AMM_V4_ADAPTER_PENDING',
        initialLiquidityUsd: 1000000 + i * 10000,
        lastVerifiedAt: Date.now()
      });
    }

    return pools;
  }

  it('Requirement 1 & 3 & 4: Persists 1,000 distinct route definitions with deterministic identity', () => {
    // 35 pools on USDC/WSOL yields 35 * 34 = 1,190 distinct directed 2-leg routes
    const pools: PoolConfig[] = [];
    for (let i = 0; i < 35; i++) {
      pools.push({
        id: `pool-scaling-${i.toString().padStart(3, '0')}`,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 30,
        verificationStatus: 'VERIFIED_DIRECT',
        initialLiquidityUsd: 500000,
        lastVerifiedAt: Date.now()
      });
    }

    const routeIndex = new RouteIndex(pools);
    const allRoutes = routeIndex.getAllRoutes();
    expect(allRoutes.length).toBeGreaterThanOrEqual(1000);

    // Take exactly 1,000 distinct route definitions
    const targetRoutes = allRoutes.slice(0, 1000);
    const targetPoolIds = new Set<string>();
    for (const r of targetRoutes) {
      for (const p of r.poolIds) targetPoolIds.add(p);
    }

    const relevantPools = pools.filter(p => targetPoolIds.has(p.id));
    const poolRecords: VerifiedPoolRecord[] = relevantPools.map(p => ({
      poolId: p.id,
      dex: p.dex,
      programId: p.programId,
      tokenAMint: p.tokenAMint,
      tokenBMint: p.tokenBMint,
      feeBps: p.feeBps,
      verificationStatus: p.verificationStatus || 'VERIFIED_DIRECT',
      initialLiquidityUsd: p.initialLiquidityUsd,
      lastVerifiedAt: p.lastVerifiedAt || Date.now(),
      createdAt: Date.now()
    }));

    // Persist minimum pool configs
    repo.upsertVerifiedPools(poolRecords);

    // Convert routes to permanent records
    const permanentRecords = targetRoutes.map(r => routeIndex.toPermanentRecord(r));
    expect(permanentRecords.length).toBe(1000);

    // Verify deterministic identity fields on all records
    for (const pr of permanentRecords) {
      expect(pr.routeId).toBeDefined();
      expect(pr.orderedPoolIds.length).toBe(2);
      expect(pr.orderedDexPrograms.length).toBe(2);
      expect(pr.orderedTokens.length).toBe(3);
      expect(pr.staticDependencies.length).toBeGreaterThan(0);
      expect(pr.protocolAdapterVersion).toBe('1.4.0');
    }

    // Persist into SQLite
    const inserted = repo.upsertRoutes(permanentRecords);
    expect(inserted).toBe(true);

    const summary = repo.getRouteSummaryStats();
    expect(summary.totalRoutes).toBe(1000);
    expect(summary.uniqueRouteCount).toBe(1000);
  });

  it('Requirement 2 & 8 & 15: Restores exactly 1,000 unique definitions with zero duplicate IDs on restart', () => {
    // 1. Populate 1,000 routes in database
    const pools: PoolConfig[] = [];
    for (let i = 0; i < 35; i++) {
      pools.push({
        id: `pool-restoration-${i.toString().padStart(3, '0')}`,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 30,
        verificationStatus: 'VERIFIED_DIRECT',
        initialLiquidityUsd: 500000,
        lastVerifiedAt: Date.now()
      });
    }

    const routeIndex = new RouteIndex(pools);
    const targetRoutes = routeIndex.getAllRoutes().slice(0, 1000);
    const poolRecords: VerifiedPoolRecord[] = pools.map(p => ({
      poolId: p.id,
      dex: p.dex,
      programId: p.programId,
      tokenAMint: p.tokenAMint,
      tokenBMint: p.tokenBMint,
      feeBps: p.feeBps,
      verificationStatus: 'VERIFIED_DIRECT',
      initialLiquidityUsd: p.initialLiquidityUsd,
      lastVerifiedAt: Date.now(),
      createdAt: Date.now()
    }));

    repo.upsertVerifiedPools(poolRecords);
    repo.upsertRoutes(targetRoutes.map(r => routeIndex.toPermanentRecord(r)));

    // Flush and close the repository
    repo.flushSync();
    repo.close();

    // 2. Simulate process restart
    const restartedRepo = new ArbitrageRepository(config);
    const savedPools = restartedRepo.getAllVerifiedPools();
    expect(savedPools.length).toBe(pools.length);

    const savedRoutes = restartedRepo.getAllRoutes();
    expect(savedRoutes.length).toBe(1000);

    // Verify zero duplicate IDs in SQLite
    const uniqueSavedIds = new Set(savedRoutes.map(r => r.routeId));
    expect(uniqueSavedIds.size).toBe(1000);

    // 3. Restore into clean RouteIndex using persisted pools
    const restoredRegistry = new PoolRegistry();
    restoredRegistry.loadPersistedPools(savedPools);

    const restartedIndex = new RouteIndex(restoredRegistry.getAllPools());
    const reconcileResult = restartedIndex.reconcilePersistentRoutes(savedRoutes);

    expect(reconcileResult.recovered + reconcileResult.blocked + reconcileResult.updated).toBe(1000);
    expect(restartedIndex.getRestoredRouteCount()).toBe(1000);
    expect(restartedIndex.getRouteCount()).toBeGreaterThanOrEqual(1000);
    expect(restartedIndex.getUniqueRouteCount()).toBeGreaterThanOrEqual(1000);

    // Verify actual pool metadata survives
    for (const pool of pools) {
      const restoredPool = restartedIndex.getPoolConfig(pool.id);
      expect(restoredPool).toBeDefined();
      expect(restoredPool?.tokenAMint).toBe(pool.tokenAMint);
      expect(restoredPool?.tokenBMint).toBe(pool.tokenBMint);
      expect(restoredPool?.feeBps).toBe(pool.feeBps);
    }

    // Confirm restored routes do not inherit READY status or stale quotes
    expect(restartedIndex.getReadyRouteCount()).toBe(0);
    for (const r of restartedIndex.getAllRoutes()) {
      expect(r.state).not.toBe('READY');
      expect(r.lastQuoteExpectedNetUSDC).toBeUndefined();
    }

    // Verify zero duplicate IDs in in-memory index
    const inMemoryRoutes = restartedIndex.getAllRoutes();
    const inMemoryIds = inMemoryRoutes.map(r => r.routeId);
    expect(new Set(inMemoryIds).size).toBe(inMemoryRoutes.length);

    // Verify exactly 1,000 unique definitions were restored with zero duplicates
    const restoredRoutes = inMemoryRoutes.filter(r => r.isRestored);
    expect(restoredRoutes.length).toBe(1000);
    expect(new Set(restoredRoutes.map(r => r.routeId)).size).toBe(1000);

    restartedRepo.close();
  });

  it('Requirement 10: Zero restored routes begin as READY upon restart (initialized as UNVALIDATED or BLOCKED)', () => {
    // Prepare routes with mixed states (some were previously READY in old session)
    const pools = [
      {
        id: 'pool-ready-test-1',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-ready-test-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      }
    ];

    const idx = new RouteIndex(pools);
    const routes = idx.getAllRoutes();
    // Simulate routes having been READY with previous quotes
    for (const r of routes) {
      idx.setRouteReady(r.routeId, { expectedNetUSDC: '1.50', timestamp: Date.now() });
    }
    expect(idx.getReadyRouteCount()).toBe(routes.length);

    // Save as READY into repository
    repo.upsertRoutes(idx.getAllPermanentRecords());
    repo.flushSync();
    repo.close();

    // Restart and restore
    const restartedRepo = new ArbitrageRepository(config);
    const saved = restartedRepo.getAllRoutes();

    const freshIdx = new RouteIndex(pools);
    freshIdx.reconcilePersistentRoutes(saved);

    // Zero restored routes begin as READY
    expect(freshIdx.getReadyRouteCount()).toBe(0);

    for (const r of freshIdx.getAllRoutes()) {
      expect(r.state).not.toBe('READY');
      expect(r.state).toBe('UNVALIDATED');
      // Stale quotes must not be preserved as executable opportunities
      expect(r.lastQuoteExpectedNetUSDC).toBeUndefined();
      expect(r.lastQuoteTimestamp).toBeUndefined();
    }

    restartedRepo.close();
  });

  it('Requirement 11: Fresh on-chain validation transitions eligible routes to READY within 2500ms and 10 slots', () => {
    const pools = [
      {
        id: 'pool-live-1',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-live-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      }
    ];

    const routeIndex = new RouteIndex(pools);
    const routes = routeIndex.getAllRoutes();
    const route = routes[0];

    // Initial state: not READY
    expect(route.state).not.toBe('READY');

    // Fresh quote arrives (age < 2500ms, slot lag <= 10)
    const freshTimestamp = Date.now();
    const isReady = routeIndex.setRouteReady(route.routeId, {
      expectedNetUSDC: '0.450000',
      timestamp: freshTimestamp
    });

    expect(isReady).toBe(true);
    expect(routeIndex.getRouteById(route.routeId)?.state).toBe('READY');
    expect(routeIndex.getReadyRouteCount()).toBe(1);

    // Expire stale check with fresh timestamp passes
    const poolStates = new Map<string, { receivedAt: number; slot: number; feedHealth: string }>();
    poolStates.set('pool-live-1', { receivedAt: freshTimestamp, slot: 1005, feedHealth: 'HEALTHY' });
    poolStates.set('pool-live-2', { receivedAt: freshTimestamp, slot: 1007, feedHealth: 'HEALTHY' });

    const expired = routeIndex.expireStaleReadyRoutes(
      (id) => poolStates.get(id),
      2500,
      10,
      1010
    );

    expect(expired.length).toBe(0);
    expect(routeIndex.getRouteById(route.routeId)?.state).toBe('READY');
  });

  it('Requirement 11 (Negative): Stale quotes (>2500ms) or excessive slot lag (>10) fail closed to STALE or BLOCKED', () => {
    const pools = [
      {
        id: 'pool-stale-1',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-stale-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      }
    ];

    const routeIndex = new RouteIndex(pools);
    const route = routeIndex.getAllRoutes()[0];

    // Transition to READY
    routeIndex.setRouteReady(route.routeId, {
      expectedNetUSDC: '0.35',
      timestamp: Date.now() - 3000 // 3 seconds ago (> 2500ms)
    });

    const poolStates = new Map<string, { receivedAt: number; slot: number; feedHealth: string }>();
    poolStates.set('pool-stale-1', { receivedAt: Date.now() - 3000, slot: 1000, feedHealth: 'HEALTHY' });
    poolStates.set('pool-stale-2', { receivedAt: Date.now() - 3000, slot: 1000, feedHealth: 'HEALTHY' });

    // Expire stale routes
    const expired = routeIndex.expireStaleReadyRoutes(
      (id) => poolStates.get(id),
      2500,
      10,
      1000
    );

    expect(expired.length).toBe(1);
    expect(route.state).toBe('STALE');
    expect(route.verificationDetails).toContain('EXPIRED_QUOTE');
    expect(routeIndex.getReadyRouteCount()).toBe(0);

    // Test excessive slot lag (> 10 slots)
    routeIndex.setRouteReady(route.routeId, { expectedNetUSDC: '0.35', timestamp: Date.now() });
    poolStates.set('pool-stale-1', { receivedAt: Date.now(), slot: 1000, feedHealth: 'HEALTHY' });
    poolStates.set('pool-stale-2', { receivedAt: Date.now(), slot: 1015, feedHealth: 'HEALTHY' }); // gap = 15 > 10

    const slotExpired = routeIndex.expireStaleReadyRoutes(
      (id) => poolStates.get(id),
      2500,
      10,
      1020
    );

    expect(slotExpired.length).toBe(1);
    expect(route.state).toBe('STALE');
    expect(route.verificationDetails).toMatch(/EXCESSIVE_SLOT_LAG|SLOT_GAP_EXCEEDED/);
  });

  it('Requirement 5 & 6: Repeated discovery updates existing records without multiplying rows', () => {
    const pools: PoolConfig[] = [];
    for (let i = 0; i < 10; i++) {
      pools.push({
        id: `pool-repeated-${i}`,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT',
        initialLiquidityUsd: 100000,
        lastVerifiedAt: 1000
      });
    }

    const routeIndex = new RouteIndex(pools);
    const routes = routeIndex.getAllRoutes();
    const count = routes.length;

    // First save
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());
    expect(repo.getRouteSummaryStats().totalRoutes).toBe(count);

    // Second save (simulating repeated discovery cycle)
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());
    expect(repo.getRouteSummaryStats().totalRoutes).toBe(count);

    // Third save with updated verification timestamps
    const updatedRecords = routeIndex.getAllPermanentRecords().map(r => ({
      ...r,
      lastVerifiedAt: 2000
    }));
    repo.upsertRoutes(updatedRecords);

    // Row count remains identical (no row explosion or duplicate IDs)
    const summary = repo.getRouteSummaryStats();
    expect(summary.totalRoutes).toBe(count);
    expect(summary.uniqueRouteCount).toBe(count);

    // Reconciling into RouteIndex also updates without multiplying in-memory count
    const recResult = routeIndex.reconcilePersistentRoutes(updatedRecords);
    expect(recResult.updated).toBe(count);
    expect(routeIndex.getRouteCount()).toBe(count);
  });

  it('Requirement 14: Invalidate or remove routes when underlying pools disappear, become unusable, or structurally change', () => {
    const pools = [
      {
        id: 'pool-removal-1',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-removal-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-removal-3',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      }
    ];

    const routeIndex = new RouteIndex(pools);
    // 3 pools with identical pair -> 3 * 2 = 6 directed routes
    expect(routeIndex.getRouteCount()).toBe(6);

    // 1. Invalidation when a pool becomes unusable
    const changed = routeIndex.invalidateRoutesForPool('pool-removal-3', 'POOL_RESERVES_CORRUPTED');
    expect(changed.length).toBeGreaterThan(0);

    for (const r of changed) {
      expect(r.state).toBe('BLOCKED');
      expect(r.verificationDetails).toBe('POOL_RESERVES_CORRUPTED');
      expect(r.isDirectToDirect).toBe(false);
    }

    // 2. Removal when a pool disappears
    const removedIds = routeIndex.removeRoutesForPool('pool-removal-3');
    // pool 3 was in 4 routes: (1->3, 3->1, 2->3, 3->2)
    expect(removedIds.length).toBe(4);
    // Remaining routes should only be (1->2, 2->1) = 2 routes
    expect(routeIndex.getRouteCount()).toBe(2);

    for (const r of routeIndex.getAllRoutes()) {
      expect(r.poolIds).not.toContain('pool-removal-3');
    }

    // Deleting from repository
    repo.deleteRoutes(removedIds);
    expect(repo.getRouteSummaryStats().totalRoutes).toBe(0);
  });

  it('Requirement 12 & 13: Non-blocking readiness queue keeps synchronous DB writes off quoting hot path', () => {
    const pools = [
      {
        id: 'pool-bench-1',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-bench-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      }
    ];

    const idx = new RouteIndex(pools);
    const route = idx.getAllRoutes()[0];
    repo.saveRoute(idx.toPermanentRecord(route));

    // Measure high-frequency readiness updates in memory
    const t0 = performance.now();
    const iterations = 5000;
    for (let i = 0; i < iterations; i++) {
      repo.updateRouteReadiness(route.routeId, i % 2 === 0, undefined, {
        expectedNetUSDC: (0.10 + (i % 50) * 0.01).toFixed(6),
        timestamp: Date.now()
      });
    }
    const elapsedMs = performance.now() - t0;

    // 5,000 updates in memory must complete in < 25ms (sub-microsecond per update)
    expect(elapsedMs).toBeLessThan(25);
    expect(repo.getQueuedReadinessCount()).toBe(1); // Key coalescing coalesces to 1 update entry

    // Flush persists the latest state smoothly
    repo.flushSync();
    expect(repo.getQueuedReadinessCount()).toBe(0);

    const stored = repo.getRoute(route.routeId);
    expect(stored).not.toBeNull();
  });

  it('Requirement 16: Preserves distinct reverse-direction routes and alternative pool combinations', () => {
    const poolA: PoolConfig = {
      id: 'pool-reverse-A',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_USDC_MINT,
      tokenBMint: CANONICAL_WSOL_MINT,
      feeBps: 30,
      verificationStatus: 'VERIFIED_DIRECT',
      lastVerifiedAt: Date.now()
    };
    const poolB: PoolConfig = {
      id: 'pool-reverse-B',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_USDC_MINT,
      tokenBMint: CANONICAL_WSOL_MINT,
      feeBps: 30,
      verificationStatus: 'VERIFIED_DIRECT',
      lastVerifiedAt: Date.now()
    };

    const routeIndex = new RouteIndex([poolA, poolB]);
    const routes = routeIndex.getAllRoutes();

    // 2-leg forward and reverse routes
    const forward = routes.find(r => r.routeId === 'pool-reverse-A->pool-reverse-B');
    const reverse = routes.find(r => r.routeId === 'pool-reverse-B->pool-reverse-A');

    expect(forward).toBeDefined();
    expect(reverse).toBeDefined();
    expect(forward!.routeId).not.toBe(reverse!.routeId);

    // Leg ordering is distinct
    expect(forward!.legs[0].poolId).toBe('pool-reverse-A');
    expect(forward!.legs[1].poolId).toBe('pool-reverse-B');

    expect(reverse!.legs[0].poolId).toBe('pool-reverse-B');
    expect(reverse!.legs[1].poolId).toBe('pool-reverse-A');

    // Both persist into SQLite as separate distinct records
    repo.upsertRoutes([routeIndex.toPermanentRecord(forward!), routeIndex.toPermanentRecord(reverse!)]);

    const storedForward = repo.getRoute(forward!.routeId);
    const storedReverse = repo.getRoute(reverse!.routeId);

    expect(storedForward).not.toBeNull();
    expect(storedReverse).not.toBeNull();
    expect(storedForward!.routeId).toBe('pool-reverse-A->pool-reverse-B');
    expect(storedReverse!.routeId).toBe('pool-reverse-B->pool-reverse-A');
  });

  it('Requirement 18: Exposes restored-route counts, unique-route counts, and current READY counts in telemetry', () => {
    const pools = [
      {
        id: 'pool-telemetry-1',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      },
      {
        id: 'pool-telemetry-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_USDC_MINT,
        tokenBMint: CANONICAL_WSOL_MINT,
        feeBps: 20,
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      }
    ];

    const idx = new RouteIndex(pools);
    expect(idx.getUniqueRouteCount()).toBe(2);
    expect(idx.getReadyRouteCount()).toBe(0);

    // Reconciling simulated saved routes updates restoredRouteCount
    const saved = idx.getAllPermanentRecords();
    idx.reconcilePersistentRoutes(saved);
    expect(idx.getRestoredRouteCount()).toBe(2);

    // Transition one route to READY
    idx.setRouteReady(saved[0].routeId, { expectedNetUSDC: '0.80', timestamp: Date.now() });
    expect(idx.getReadyRouteCount()).toBe(1);

    // Check scanner health status telemetry
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, repo);
    const health = scanner.getHealthStatus();

    expect(health.uniqueRouteCount).toBeDefined();
    expect(health.readyRouteCount).toBeDefined();
    expect(health.restoredRouteCount).toBeDefined();
    expect(health.verifiedRouteCount).toBeDefined();

    scanner.stop();
  });
});
