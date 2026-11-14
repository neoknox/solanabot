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
    for (const suffix of ['', '-wal', '-shm']) {
      const p = testDbPath + suffix;
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
    repo = new ArbitrageRepository(config);
    poolRegistry = new PoolRegistry();
  });

  afterEach(() => {
    if (repo) {
      repo.close();
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const p = testDbPath + suffix;
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
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

  it('Gate 1.4.14 - Honest Dependency Descriptors & Verification Timestamps: No synthetic pubkeys or misleading catalog timestamps (FIX 5)', () => {
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

      // FIX 5: Remove misleading verification timestamps from default catalog
      // In default catalog, routes without genuine on-chain verification events must have lastVerifiedAt: 0
      expect(route.lastVerifiedAt).toBe(0);
    }

    // When genuine verification events occur with known provenance timestamps
    const verifiedEventTime = 1720000000000;
    const targetRoute = routeIndex.getVerifiedDirectRoutes()[0];
    for (const poolId of targetRoute.poolIds) {
      routeIndex.updatePoolStatus(poolId, 'VERIFIED_DIRECT', verifiedEventTime);
    }

    // Now route reflects the recorded timestamp from genuine verification events
    const updatedRoute = routeIndex.getRouteById(targetRoute.routeId);
    expect(updatedRoute?.lastVerifiedAt).toBe(verifiedEventTime);
  });

  it('Gate 1.4.15 - READY Expiration: Live data staleness automatically transitions READY routes to STALE (FIX 1)', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const targetRoute = routeIndex.getVerifiedDirectRoutes()[0];

    // 1. Route quoted and marked READY with recent timestamp
    const now = Date.now();
    routeIndex.setRouteReady(targetRoute.routeId, {
      expectedNetUSDC: '0.650000',
      timestamp: now
    });
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('READY');

    // 2. Data becomes stale: Quote age exceeds maxSlotAgeMs (e.g. 2500ms)
    routeIndex.getRouteById(targetRoute.routeId)!.lastQuoteTimestamp = now - 3000;
    const expiredByQuoteAge = routeIndex.expireStaleReadyRoutes(
      (_id) => ({ receivedAt: now, slot: 100, feedHealth: 'HEALTHY' }),
      2500,
      10,
      100
    );
    expect(expiredByQuoteAge.some(r => r.routeId === targetRoute.routeId)).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('EXPIRED_QUOTE');

    // 3. Re-mark READY, then dependency feed health becomes UNHEALTHY
    routeIndex.setRouteReady(targetRoute.routeId, { expectedNetUSDC: '0.650000', timestamp: Date.now() });
    const expiredByFeed = routeIndex.expireStaleReadyRoutes(
      (_id) => ({ receivedAt: Date.now(), slot: 100, feedHealth: 'STALE' }),
      2500,
      10,
      100
    );
    expect(expiredByFeed.some(r => r.routeId === targetRoute.routeId)).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_OR_UNHEALTHY_FEED_EVIDENCE');

    // 4. Re-mark READY, then slot lag exceeds MAX_SLOT_GAP (10 slots)
    routeIndex.setRouteReady(targetRoute.routeId, { expectedNetUSDC: '0.650000', timestamp: Date.now() });
    const expiredBySlotLag = routeIndex.expireStaleReadyRoutes(
      (_id) => ({ receivedAt: Date.now(), slot: 85, feedHealth: 'HEALTHY' }),
      2500,
      10,
      100 // current slot 100 vs pool slot 85 -> gap 15 > maxSlotGap 10
    );
    expect(expiredBySlotLag.some(r => r.routeId === targetRoute.routeId)).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('STALE');
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('EXCESSIVE_SLOT_LAG');
  });

  it('Gate 1.4.16 - Runtime Verification Persistence & Safe Restart Revalidation (FIX 2)', () => {
    // 1. Update pool verification on registry and verify it notifies and persists to SQLite
    const customPoolAddr = 'CustomDiscoveredPoolAddr11111111111111111111';
    poolRegistry.register({
      id: customPoolAddr,
      dex: 'ORCA_WHIRLPOOL',
      programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      tokenAMint: 'So11111111111111111111111111111111111111112',
      tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      feeBps: 4,
      initialLiquidityUsd: 500000,
      verificationStatus: 'QUOTE_UNVERIFIED',
      blockerReason: 'PENDING_ONCHAIN_REVALIDATION',
      lastVerifiedAt: 0
    });

    const routeIndex = new RouteIndex(poolRegistry.getAllPools());

    // Wire persistence callback as ArbitrageScanner does
    poolRegistry.onVerificationChange((poolId, status, blockerReason, lastVerifiedAt) => {
      routeIndex.updatePoolStatus(poolId, status, lastVerifiedAt);
      const pool = poolRegistry.getPool(poolId);
      if (pool) {
        repo.saveVerifiedPool({
          poolId: pool.id,
          dex: pool.dex,
          programId: pool.programId,
          tokenAMint: pool.tokenAMint,
          tokenBMint: pool.tokenBMint,
          feeBps: pool.feeBps,
          verificationStatus: status,
          blockerReason: blockerReason,
          initialLiquidityUsd: pool.initialLiquidityUsd || 0,
          accountLayoutSize: 0,
          lastVerifiedAt: lastVerifiedAt || 0,
          createdAt: Date.now()
        });
      }
    });

    // Simulate on-chain verification promotion event
    const genuineVerifiedTime = 1725000000000;
    poolRegistry.updatePoolVerification(customPoolAddr, 'VERIFIED_DIRECT', undefined, genuineVerifiedTime);

    // Verify it was persisted to SQLite
    const storedPool = repo.getVerifiedPool(customPoolAddr);
    expect(storedPool).not.toBeNull();
    expect(storedPool?.verificationStatus).toBe('VERIFIED_DIRECT');
    expect(storedPool?.lastVerifiedAt).toBe(genuineVerifiedTime);

    // 2. Restart simulation: loaded persisted pools must NOT automatically count as fresh on-chain validation
    const freshRegistry = new PoolRegistry();
    const persistedPools = repo.getAllVerifiedPools();
    freshRegistry.loadPersistedPools(persistedPools);

    const reloadedCustomPool = freshRegistry.getPool(customPoolAddr);
    expect(reloadedCustomPool).toBeDefined();
    // Reverted to QUOTE_UNVERIFIED upon restart pending live on-chain revalidation!
    expect(reloadedCustomPool?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    expect(reloadedCustomPool?.blockerReason).toBe('PENDING_RESTART_REVALIDATION');
    // Provenance timestamp is preserved
    expect(reloadedCustomPool?.lastVerifiedAt).toBe(genuineVerifiedTime);
  });

  it('Gate 1.4.17 - Strict Freshness Validation: Missing, invalid, expired, and future evidence fails closed (FIX 3)', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const targetRoute = routeIndex.getVerifiedDirectRoutes()[0];

    // Put route in STALE
    routeIndex.setRouteStale(targetRoute.routeId, 'INIT');
    const now = Date.now();

    // A) Missing timestamp evidence (undefined or <= 0)
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ slot: 100, feedHealth: 'HEALTHY' }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_TIMESTAMP_EVIDENCE');

    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: 0, slot: 100, feedHealth: 'HEALTHY' }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_TIMESTAMP_EVIDENCE');

    // B) Future timestamp evidence (> now + 5000)
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now + 10000, slot: 100, feedHealth: 'HEALTHY' }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('FUTURE_TIMESTAMP');

    // C) Expired timestamp evidence (> maxSlotAgeMs)
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now - 6000, slot: 100, feedHealth: 'HEALTHY' }), 2500)).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('EXPIRED_DEPENDENCY_STATE');

    // D) Missing slot evidence (undefined or <= 0)
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now, feedHealth: 'HEALTHY' }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_SLOT_EVIDENCE');

    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now, slot: -5, feedHealth: 'HEALTHY' }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_SLOT_EVIDENCE');

    // E) Future slot (> currentSlot + 10)
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now, slot: 150, feedHealth: 'HEALTHY' }), 2500, 10, 100)).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('FUTURE_SLOT');

    // F) Excessive slot lag (currentSlot - slot > maxSlotGap)
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now, slot: 80, feedHealth: 'HEALTHY' }), 2500, 10, 100)).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('EXCESSIVE_SLOT_LAG');

    // G) Missing or unhealthy feed health
    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now, slot: 100, feedHealth: undefined }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_OR_UNHEALTHY_FEED_EVIDENCE');

    expect(routeIndex.validateAndRestoreRoute(targetRoute.routeId, () => ({ receivedAt: now, slot: 100, feedHealth: 'DISCONNECTED' }))).toBe(false);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.verificationDetails).toContain('MISSING_OR_UNHEALTHY_FEED_EVIDENCE');

    // H) All evidence present, fresh, and valid -> Restores to READY!
    const restored = routeIndex.validateAndRestoreRoute(
      targetRoute.routeId,
      () => ({ receivedAt: now, slot: 100, feedHealth: 'HEALTHY' }),
      2500,
      10,
      102
    );
    expect(restored).toBe(true);
    expect(routeIndex.getRouteById(targetRoute.routeId)?.state).toBe('READY');
  });

  it('Gate 1.4.18 - SQLite Write Reliability: Bounded retries and no permanent loss on database failure (FIX 4)', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());

    const targetRoute = routeIndex.getVerifiedDirectRoutes()[0];

    // Queue readiness update
    repo.updateRouteReadiness(targetRoute.routeId, true, undefined, {
      expectedNetUSDC: '0.700000',
      timestamp: Date.now()
    });
    expect(repo.getQueuedReadinessCount()).toBe(1);

    // Simulate database write failure by replacing transaction with throwing mock
    const originalTx = (repo as any).batchUpdateReadinessTx;
    let attempts = 0;
    (repo as any).batchUpdateReadinessTx = () => {
      attempts++;
      throw new Error('Simulated SQLite disk lock error');
    };

    // First flush fails
    repo.flushSync();
    expect(attempts).toBe(1);
    expect(repo.getPersistenceErrorsCount()).toBeGreaterThan(0);
    // FIX 4: Update is NOT permanently discarded! Retained in queue for retry
    expect(repo.getQueuedReadinessCount()).toBe(1);

    // Second flush fails
    repo.flushSync();
    expect(attempts).toBe(2);
    expect(repo.getQueuedReadinessCount()).toBe(1);

    // Restore working transaction
    (repo as any).batchUpdateReadinessTx = originalTx;

    // Third flush succeeds
    repo.flushSync();
    expect(repo.getQueuedReadinessCount()).toBe(0);

    // Stored route reflects the committed update
    const stored = repo.getRoute(targetRoute.routeId);
    expect(stored?.state).toBe('READY');
    expect(stored?.lastQuoteExpectedNetUSDC).toBe('0.700000');
  });

  it('Gate 1.4.19 - Route State Consistency: When pool verification changes, affected route states remain consistent in RouteIndex and SQLite via asynchronous non-blocking queue', () => {
    // 1. Initial state: Orca pools are VERIFIED_DIRECT, Orca-Orca routes are VERIFIED in RouteIndex & SQLite
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    repo.upsertRoutes(routeIndex.getAllPermanentRecords());

    const directRoutes = routeIndex.getVerifiedDirectRoutes();
    expect(directRoutes.length).toBeGreaterThan(0);
    const targetRoute = directRoutes[0];
    const targetPoolId = targetRoute.legs[0].poolId;

    // Verify initial SQLite state
    const initialStored = repo.getRoute(targetRoute.routeId);
    expect(initialStored?.state).toBe('VERIFIED');

    // 2. Simulate pool verification change: Pool becomes QUOTE_UNVERIFIED
    const changedRoutes = routeIndex.updatePoolStatus(targetPoolId, 'QUOTE_UNVERIFIED');
    expect(changedRoutes.some(r => r.routeId === targetRoute.routeId)).toBe(true);

    // In-memory RouteIndex is immediately updated: BLOCKED
    const updatedRouteInMemory = routeIndex.getRouteById(targetRoute.routeId);
    expect(updatedRouteInMemory?.state).toBe('BLOCKED');
    expect(updatedRouteInMemory?.verificationDetails).toContain(`DEPENDENCY_UNVERIFIED:${targetPoolId}`);

    // Non-blocking queue receives update without synchronous quote hot-path disk write
    for (const route of changedRoutes) {
      repo.queueRouteStateUpdate(route.routeId, route.state, route.verificationDetails);
    }
    expect(repo.getQueuedReadinessCount()).toBeGreaterThan(0);

    // Flush asynchronously queued updates to SQLite
    repo.flushSync();
    expect(repo.getQueuedReadinessCount()).toBe(0);

    // SQLite routes table now accurately reflects BLOCKED state and verification details
    const storedAfterBlocked = repo.getRoute(targetRoute.routeId);
    expect(storedAfterBlocked?.state).toBe('BLOCKED');
    expect(storedAfterBlocked?.verificationDetails).toContain(`DEPENDENCY_UNVERIFIED:${targetPoolId}`);

    // 3. Restore pool verification back to VERIFIED_DIRECT
    const restoredRoutes = routeIndex.updatePoolStatus(targetPoolId, 'VERIFIED_DIRECT', Date.now());
    expect(restoredRoutes.some(r => r.routeId === targetRoute.routeId)).toBe(true);

    // In-memory RouteIndex is immediately restored to VERIFIED
    const restoredRouteInMemory = routeIndex.getRouteById(targetRoute.routeId);
    expect(restoredRouteInMemory?.state).toBe('VERIFIED');
    expect(restoredRouteInMemory?.verificationDetails).toBeUndefined();

    // Queue and flush to SQLite
    for (const route of restoredRoutes) {
      repo.queueRouteStateUpdate(route.routeId, route.state, route.verificationDetails);
    }
    repo.flushSync();

    // SQLite routes table now accurately reflects restored VERIFIED state with blocker reason cleared
    const storedAfterRestored = repo.getRoute(targetRoute.routeId);
    expect(storedAfterRestored?.state).toBe('VERIFIED');
    expect(storedAfterRestored?.verificationDetails).toBeUndefined();
  });

  it('Gate 1.4.20 - Lifecycle Transition Tracking: Accurately records peak READY count, READY-to-STALE transitions, and STALE-to-READY recoveries', () => {
    const pools = poolRegistry.getAllPools();
    const routeIndex = new RouteIndex(pools);
    const directRoutes = routeIndex.getVerifiedDirectRoutes();
    expect(directRoutes.length).toBeGreaterThanOrEqual(2);

    const routeA = directRoutes[0];
    const routeB = directRoutes[1];

    // Initial transition stats
    expect(routeIndex.getLifecycleTransitionStats()).toEqual({
      readyToStaleTransitions: 0,
      staleToReadyRecoveries: 0,
      peakReadyCount: 0
    });

    // 1. Mark Route A and Route B READY -> Peak count becomes 2
    routeIndex.setRouteReady(routeA.routeId, { expectedNetUSDC: '0.500000', timestamp: Date.now() });
    expect(routeIndex.getLifecycleTransitionStats().peakReadyCount).toBe(1);

    routeIndex.setRouteReady(routeB.routeId, { expectedNetUSDC: '0.600000', timestamp: Date.now() });
    expect(routeIndex.getLifecycleTransitionStats().peakReadyCount).toBe(2);

    // 2. Mark Route A STALE -> readyToStaleTransitions increments
    routeIndex.setRouteStale(routeA.routeId, 'EXPIRED_QUOTE');
    expect(routeIndex.getLifecycleTransitionStats().readyToStaleTransitions).toBe(1);

    // 3. Expire Route B via expireStaleReadyRoutes -> readyToStaleTransitions increments again
    const expired = routeIndex.expireStaleReadyRoutes(() => undefined);
    expect(expired.some(r => r.routeId === routeB.routeId)).toBe(true);
    expect(routeIndex.getLifecycleTransitionStats().readyToStaleTransitions).toBe(2);

    // 4. Restore Route A from STALE back to READY -> staleToReadyRecoveries increments
    const now = Date.now();
    const restored = routeIndex.validateAndRestoreRoute(
      routeA.routeId,
      () => ({ receivedAt: now, slot: 500, feedHealth: 'HEALTHY' }),
      2500,
      10,
      501
    );
    expect(restored).toBe(true);
    expect(routeIndex.getLifecycleTransitionStats().staleToReadyRecoveries).toBe(1);
    expect(routeIndex.getLifecycleTransitionStats().peakReadyCount).toBe(2);
  });
});
