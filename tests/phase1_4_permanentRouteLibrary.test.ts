import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { loadConfig } from '../src/config/index.js';
import {
  PermanentRouteRecord,
  VerifiedPoolRecord,
  RouteState
} from '../src/types/index.js';

describe('Phase 1.4: Permanent Route Library Suite (90-Day Roadmap Phase 1 Gate)', () => {
  const testDbPath = path.resolve(__dirname, 'test_route_library.db');
  let config = loadConfig({ DB_PATH: testDbPath });
  let repo: ArbitrageRepository;
  let poolRegistry: PoolRegistry;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    repo = new ArbitrageRepository(config);
    poolRegistry = new PoolRegistry();
  });

  afterEach(() => {
    if (repo) {
      repo.close();
    }
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  it('Gate 1.4.1 - Stable Identity: RouteIndex produces deterministic stable route IDs across multiple builds', () => {
    const pools = poolRegistry.getAllPools();
    const index1 = new RouteIndex(pools);
    const routes1 = index1.getAllRoutes();

    const index2 = new RouteIndex(pools);
    const routes2 = index2.getAllRoutes();

    expect(routes1.length).toBeGreaterThan(0);
    expect(routes1.length).toBe(routes2.length);

    for (let i = 0; i < routes1.length; i++) {
      expect(routes1[i].routeId).toBe(routes2[i].routeId);
      expect(routes1[i].cycleType).toBe(routes2[i].cycleType);
      expect(routes1[i].poolIds).toEqual(routes2[i].poolIds);
      expect(routes1[i].legs.length).toBe(routes2[i].legs.length);
      expect(routes1[i].estimatedAccounts).toBe(routes2[i].estimatedAccounts);
      expect(routes1[i].estimatedComputeUnits).toBe(routes2[i].estimatedComputeUnits);
    }
  });

  it('Gate 1.4.2 - Deduplication: Upserting routes into SQLite maintains primary key uniqueness without duplicates', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const permanentRecords = routeIndex.getAllPermanentRecords();

    expect(permanentRecords.length).toBeGreaterThan(0);

    // Initial persistence
    repo.upsertRoutes(permanentRecords);
    let stats = repo.getRouteSummaryStats();
    expect(stats.totalRoutes).toBe(permanentRecords.length);

    // Re-upsert identical records (simulating repeated scanner startup or scout discovery)
    repo.upsertRoutes(permanentRecords);
    stats = repo.getRouteSummaryStats();
    expect(stats.totalRoutes).toBe(permanentRecords.length);

    // Re-upserting single route
    repo.saveRoute(permanentRecords[0]);
    stats = repo.getRouteSummaryStats();
    expect(stats.totalRoutes).toBe(permanentRecords.length);
  });

  it('Gate 1.4.3 - Complete Route Definition: SQLite stores and restores complete route metadata and dependencies', () => {
    const sampleRecord: PermanentRouteRecord = {
      routeId: 'pool-orca-1->pool-raydium-1',
      cycleType: '2_LEG',
      isIntraDex: false,
      orderedPoolIds: ['pool-orca-1', 'pool-raydium-1'],
      orderedDexPrograms: [
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
      ],
      orderedTokens: [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      ],
      staticDependencies: [
        { pubkey: 'pool-orca-1', role: 'POOL_ACCOUNT', isWritable: true, isSigner: false },
        { pubkey: 'pool-raydium-1', role: 'POOL_ACCOUNT', isWritable: true, isSigner: false }
      ],
      dynamicDependencies: [
        { addressType: 'UNRESOLVED_DESCRIPTOR', descriptor: 'pool-orca-1:tick_arrays', isResolved: false, role: 'TICK_ARRAY', type: 'TICK_ARRAY', refreshIntervalMs: 400 },
        { addressType: 'UNRESOLVED_DESCRIPTOR', descriptor: 'pool-raydium-1:vaults', isResolved: false, role: 'TOKEN_VAULT_A', type: 'VAULT_RESERVE', refreshIntervalMs: 400 }
      ],
      protocolAdapterVersion: '1.4.0',
      estimatedAccounts: 24,
      estimatedComputeUnits: 160000,
      state: 'VERIFIED',
      isUnprofitablePreserved: true,
      verificationDetails: 'Technical structure verified on-chain',
      lastVerifiedAt: 1700000000000,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    };

    repo.saveRoute(sampleRecord);

    const fetched = repo.getRoute(sampleRecord.routeId);
    expect(fetched).not.toBeNull();
    expect(fetched!.routeId).toBe(sampleRecord.routeId);
    expect(fetched!.cycleType).toBe(sampleRecord.cycleType);
    expect(fetched!.isIntraDex).toBe(sampleRecord.isIntraDex);
    expect(fetched!.orderedPoolIds).toEqual(sampleRecord.orderedPoolIds);
    expect(fetched!.orderedDexPrograms).toEqual(sampleRecord.orderedDexPrograms);
    expect(fetched!.orderedTokens).toEqual(sampleRecord.orderedTokens);
    expect(fetched!.staticDependencies).toEqual(sampleRecord.staticDependencies);
    expect(fetched!.dynamicDependencies).toEqual(sampleRecord.dynamicDependencies);
    expect(fetched!.protocolAdapterVersion).toBe('1.4.0');
    expect(fetched!.estimatedAccounts).toBe(24);
    expect(fetched!.estimatedComputeUnits).toBe(160000);
    expect(fetched!.state).toBe('VERIFIED');
    expect(fetched!.isUnprofitablePreserved).toBe(true);
  });

  it('Gate 1.4.4 - Restart Recovery: Database survives process termination and restores all routes intact', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const permanentRecords = routeIndex.getAllPermanentRecords();

    repo.upsertRoutes(permanentRecords);

    const initialSummary = repo.getRouteSummaryStats();
    expect(initialSummary.totalRoutes).toBe(permanentRecords.length);

    // Simulate process termination and restart
    repo.close();

    const restartedRepo = new ArbitrageRepository(config);
    const restartedSummary = restartedRepo.getRouteSummaryStats();

    expect(restartedSummary.totalRoutes).toBe(initialSummary.totalRoutes);
    expect(restartedSummary.twoLegCount).toBe(initialSummary.twoLegCount);
    expect(restartedSummary.threeLegCount).toBe(initialSummary.threeLegCount);
    expect(restartedSummary.intraDexCount).toBe(initialSummary.intraDexCount);
    expect(restartedSummary.interDexCount).toBe(initialSummary.interDexCount);

    const sampleRoute = restartedRepo.getRoute(permanentRecords[0].routeId);
    expect(sampleRoute).not.toBeNull();
    expect(sampleRoute!.routeId).toBe(permanentRecords[0].routeId);

    restartedRepo.close();
  });

  it('Gate 1.4.5 - Strict Distinction of VERIFIED versus READY: Stored records are not READY until live hydration', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);

    // Save initial verified routes into repository
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());

    // Before live quoting, verified direct-to-direct routes must be VERIFIED, not READY
    const verifiedDirectRoutes = routeIndex.getVerifiedDirectRoutes();
    expect(verifiedDirectRoutes.length).toBeGreaterThan(0);

    for (const route of verifiedDirectRoutes) {
      expect(route.state).toBe('VERIFIED');
      expect(route.state).not.toBe('READY');
    }

    expect(routeIndex.getReadyRouteCount()).toBe(0);

    // Simulate live quote arrival
    const targetRoute = verifiedDirectRoutes[0];
    routeIndex.setRouteReady(targetRoute.routeId, {
      expectedNetUSDC: '0.650000',
      timestamp: Date.now()
    });

    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('READY');
    expect(routeIndex.getReadyRouteCount()).toBe(1);

    // Persisting this into repository records the readiness
    repo.updateRouteReadiness(targetRoute.routeId, true, undefined, {
      expectedNetUSDC: '0.650000',
      timestamp: Date.now()
    });

    const stored = repo.getRoute(targetRoute.routeId);
    expect(stored?.state).toBe('READY');
    expect(stored?.lastQuoteExpectedNetUSDC).toBe('0.650000');
  });

  it('Gate 1.4.6 - Unprofitable Routes Preservation: Technically valid routes showing negative profit are never purged', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const verifiedDirectRoutes = routeIndex.getVerifiedDirectRoutes();
    const targetRoute = verifiedDirectRoutes[0];

    // Live quote yields negative net profit (-$1.25 USDC)
    routeIndex.setRouteReady(targetRoute.routeId, {
      expectedNetUSDC: '-1.250000',
      timestamp: Date.now()
    });

    // The route IS READY and technically valid, despite being currently unprofitable
    const liveRoute = routeIndex.getRouteById(targetRoute.routeId);
    expect(liveRoute?.state).toBe('READY');
    expect(liveRoute?.isUnprofitablePreserved).toBe(true);

    repo.saveRoute(routeIndex.toPermanentRecord(liveRoute!));

    const stored = repo.getRoute(targetRoute.routeId);
    expect(stored).not.toBeNull();
    expect(stored?.state).toBe('READY');
    expect(stored?.isUnprofitablePreserved).toBe(true);
    expect(stored?.lastQuoteExpectedNetUSDC).toBe('-1.250000');

    // Verify all unprofitable routes in index remain intact and available for future price moves
    expect(routeIndex.getAllRoutes().length).toBe(pools.length > 0 ? routeIndex.getRouteCount() : 0);
  });

  it('Gate 1.4.7 - STALE Transitions and Validated Freshness Restoration: Safe dependency revalidation before READY restoration', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const targetRoute = routeIndex.getVerifiedDirectRoutes()[0];

    // 1. Quoted and ready
    const markReady = routeIndex.setRouteReady(targetRoute.routeId, {
      expectedNetUSDC: '0.550000',
      timestamp: Date.now()
    });
    expect(markReady).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('READY');

    // 2. Transitory slot mismatch / stale quote arrives -> Transitions to STALE
    const markStale = routeIndex.setRouteStale(targetRoute.routeId, 'SLOT_MISMATCH');
    expect(markStale).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');
    expect(routeIndex.getStaleRouteCount()).toBe(1);

    // Crucial: Route is NOT marked BLOCKED (it is structurally verified)
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).not.toBe('BLOCKED');

    // 3. Unsafe shortcut eliminated: Restoration rejected if pool state is missing
    const restoredMissing = routeIndex.validateAndRestoreRoute(
      targetRoute.routeId,
      (_poolId) => undefined
    );
    expect(restoredMissing).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');

    // 4. Restoration rejected if feed health is not HEALTHY
    const restoredUnhealthy = routeIndex.validateAndRestoreRoute(
      targetRoute.routeId,
      (_poolId) => ({ receivedAt: Date.now(), slot: 100, feedHealth: 'STALE' })
    );
    expect(restoredUnhealthy).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');

    // 5. Restoration rejected if quote age exceeds maxSlotAgeMs
    const restoredOld = routeIndex.validateAndRestoreRoute(
      targetRoute.routeId,
      (_poolId) => ({ receivedAt: Date.now() - 15000, slot: 100, feedHealth: 'HEALTHY' }),
      5000
    );
    expect(restoredOld).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');

    // 6. Restoration rejected if slot gap exceeds maxSlotGap
    let callIdx = 0;
    const restoredGap = routeIndex.validateAndRestoreRoute(
      targetRoute.routeId,
      (_poolId) => {
        callIdx++;
        return { receivedAt: Date.now(), slot: callIdx === 1 ? 100 : 150, feedHealth: 'HEALTHY' };
      },
      5000,
      20
    );
    expect(restoredGap).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');

    // 7. Fresh valid state confirmed -> Restored to READY
    const restoredFresh = routeIndex.validateAndRestoreRoute(
      targetRoute.routeId,
      (_poolId) => ({ receivedAt: Date.now(), slot: 100, feedHealth: 'HEALTHY' }),
      5000,
      20,
      100
    );
    expect(restoredFresh).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('READY');
  });

  it('Gate 1.4.8 - Scanner Automatic Synchronization: ArbitrageScanner synchronizes route library upon instantiation', () => {
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, repo);

    const stats = scanner.getRouteLibrarySummary();
    expect(stats.totalRoutes).toBeGreaterThan(0);
    expect(stats.twoLegCount).toBeGreaterThan(0);
    expect(stats.threeLegCount).toBeGreaterThan(0);
    expect(stats.verifiedPoolCount).toBeGreaterThan(0);
    expect(stats.verifiedDirectPoolCount).toBeGreaterThan(0);
    expect(stats.totalStoredPoolCount).toBeGreaterThanOrEqual(stats.verifiedDirectPoolCount);
    expect(stats.persistenceErrorsCount).toBe(0);

    const routeIndex = scanner.getRouteIndex();
    expect(routeIndex.getRouteCount()).toBe(stats.totalRoutes);

    scanner.stop();
  });

  it('Gate 1.4.9 - Scanner Restart Recovery: Pre-existing SQLite routes are reconciled into live RouteIndex on restart', () => {
    // Populate database with pools and routes
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    repo.upsertVerifiedPools(pools.map(p => ({
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
    })));
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());

    // Flush and close repo
    repo.flushSync();
    repo.close();

    // Start a fresh scanner using the existing database
    const freshRepo = new ArbitrageRepository(config);
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, freshRepo);

    // Verify RouteIndex successfully loaded and reconciled routes from SQLite
    const recoveredIndex = scanner.getRouteIndex();
    expect(recoveredIndex.getRouteCount()).toBeGreaterThan(0);

    // Reconciled routes must NOT be READY before live quote arrives
    expect(recoveredIndex.getReadyRouteCount()).toBe(0);

    // Verified direct routes must be VERIFIED
    const directRoutes = recoveredIndex.getVerifiedDirectRoutes();
    expect(directRoutes.length).toBeGreaterThan(0);
    for (const r of directRoutes) {
      expect(r.state).toBe('VERIFIED');
    }

    // Unverified routes must be BLOCKED
    const blockedRoutes = recoveredIndex.getBlockedRoutes();
    expect(blockedRoutes.length).toBeGreaterThan(0);
    for (const r of blockedRoutes) {
      expect(r.state).toBe('BLOCKED');
    }

    scanner.stop();
  });

  it('Gate 1.4.10 - Structural vs Outage Separation: BLOCKED routes cannot transition to READY or STALE', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const blockedRoutes = routeIndex.getBlockedRoutes();
    expect(blockedRoutes.length).toBeGreaterThan(0);

    const blockedRoute = blockedRoutes[0];
    expect(blockedRoute.state).toBe('BLOCKED');

    // Attempting to mark a BLOCKED route as READY must fail
    const readyResult = routeIndex.setRouteReady(blockedRoute.routeId, {
      expectedNetUSDC: '1.500000',
      timestamp: Date.now()
    });
    expect(readyResult).toBe(false);
    expect(routeIndex.getRouteById(blockedRoute.routeId)?.state).toBe('BLOCKED');

    // Attempting to mark a BLOCKED route as STALE must fail
    const staleResult = routeIndex.setRouteStale(blockedRoute.routeId, 'SLOT_MISMATCH');
    expect(staleResult).toBe(false);
    expect(routeIndex.getRouteById(blockedRoute.routeId)?.state).toBe('BLOCKED');

    // Attempting to validateAndRestore a BLOCKED route must fail
    const restoreResult = routeIndex.validateAndRestoreRoute(
      blockedRoute.routeId,
      (_poolId) => ({ receivedAt: Date.now(), slot: 100, feedHealth: 'HEALTHY' })
    );
    expect(restoreResult).toBe(false);
    expect(routeIndex.getRouteById(blockedRoute.routeId)?.state).toBe('BLOCKED');
  });

  it('Gate 1.4.11 - Non-Blocking Readiness Queue & Coalescing: Writes stay off quoting hot path', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());

    const targetRoute = routeIndex.getVerifiedDirectRoutes()[0];

    // Rapid queueing of readiness updates
    repo.updateRouteReadiness(targetRoute.routeId, true, undefined, {
      expectedNetUSDC: '0.250000',
      timestamp: Date.now()
    });
    repo.updateRouteReadiness(targetRoute.routeId, false, 'STALE_QUOTE');
    repo.updateRouteReadiness(targetRoute.routeId, true, undefined, {
      expectedNetUSDC: '0.600000',
      timestamp: Date.now()
    });

    // Before explicit flushSync or getRoute, the DB has not executed 3 disk transactions
    // getRoute triggers flushSync to read the latest authoritative state
    const record = repo.getRoute(targetRoute.routeId);
    expect(record?.state).toBe('READY');
    expect(record?.lastQuoteExpectedNetUSDC).toBe('0.600000');
  });

  it('Gate 1.4.12 - Persistence Error Visibility: Storage failures are tracked and surfaced without crashing', () => {
    expect(repo.getPersistenceErrorsCount()).toBe(0);
    expect(repo.getLastPersistenceError()).toBeUndefined();

    // Trigger error recording
    repo.recordPersistenceError('test_operation', new Error('Simulated SQLite disk write failure'));

    expect(repo.getPersistenceErrorsCount()).toBe(1);
    const lastErr = repo.getLastPersistenceError();
    expect(lastErr).toBeDefined();
    expect(lastErr?.operation).toBe('test_operation');
    expect(lastErr?.error).toContain('Simulated SQLite disk write failure');

    const stats = repo.getRouteSummaryStats();
    expect(stats.persistenceErrorsCount).toBe(1);
  });

  it('Gate 1.4.13 - Accurate Pool Storage Breakdown: Distinguish VERIFIED_DIRECT from QUOTE_UNVERIFIED pools', () => {
    const pools = poolRegistry.getAllPools();
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

    repo.upsertVerifiedPools(verifiedPoolRecords);

    const stats = repo.getRouteSummaryStats();
    expect(stats.totalStoredPoolCount).toBe(pools.length);
    expect(stats.verifiedDirectPoolCount).toBeGreaterThan(0);
    expect(stats.unverifiedPoolCount).toBeGreaterThan(0);
    expect(stats.verifiedDirectPoolCount + stats.unverifiedPoolCount).toBe(stats.totalStoredPoolCount);
    // verifiedPoolCount alias matches verifiedDirectPoolCount
    expect(stats.verifiedPoolCount).toBe(stats.verifiedDirectPoolCount);
  });

  it('Gate 1.4.14 - Honest Dependency Descriptors & Verification Timestamps: No synthetic pubkeys or fake timestamps', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const routes = routeIndex.getAllRoutes();

    for (const route of routes) {
      // Dynamic dependencies must clearly distinguish resolved vs unresolved descriptors
      for (const dyn of route.dynamicDependencies) {
        if (!dyn.isResolved) {
          expect(dyn.addressType).toBe('UNRESOLVED_DESCRIPTOR');
          expect(dyn.descriptor).toBeDefined();
          // pubkey should NOT be a fake synthetic address
          expect(dyn.pubkey).toBeUndefined();
        } else {
          expect(dyn.addressType).toBe('RESOLVED_PUBKEY');
          expect(dyn.pubkey).toBeDefined();
        }
      }

      // If route contains unverified pools, lastVerifiedAt must be 0, never Date.now()
      if (!route.isDirectToDirect) {
        expect(route.lastVerifiedAt).toBe(0);
      } else {
        expect(route.lastVerifiedAt).toBeGreaterThan(0);
      }
    }
  });
});
