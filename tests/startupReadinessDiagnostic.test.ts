import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RouteIndex } from '../src/scanner/routeIndex';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner';
import { loadConfig } from '../src/config';
import { PermanentRouteRecord, RouteState } from '../src/types';
import fs from 'fs';
import path from 'path';

describe('SOLANABOT — Startup Readiness & Route Consistency Suite', () => {
  const testDb = path.join(process.cwd(), 'data', 'test_startup_readiness.db');

  beforeEach(() => {
    if (fs.existsSync(testDb)) {
      try { fs.unlinkSync(testDb); } catch {}
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDb)) {
      try { fs.unlinkSync(testDb); } catch {}
    }
  });

  it('1. Route state consistency: reconcilePersistentRoutes retains 100% state coverage without discrepancy', () => {
    const mockPools: any[] = [
      { id: 'poolA', dex: 'RAYDIUM_AMM', tokenAMint: 'token1', tokenBMint: 'token2', verificationStatus: 'VERIFIED_DIRECT' },
      { id: 'poolB', dex: 'ORCA_WHIRLPOOL', tokenAMint: 'token1', tokenBMint: 'token2', verificationStatus: 'VERIFIED_DIRECT' },
      { id: 'poolC', dex: 'RAYDIUM_CLMM', tokenAMint: 'token2', tokenBMint: 'token3', verificationStatus: 'VERIFIED_DIRECT' }
    ];
    const routeIndex = new RouteIndex(mockPools);

    // Simulate persistent routes reconstructed from SQLite
    const mockPersistentRoutes: any[] = [
      {
        routeId: 'poolA->poolB',
        poolAId: 'poolA',
        poolBId: 'poolB',
        tokenInMint: 'token1',
        tokenOutMint: 'token2',
        directionA: 'A_TO_B',
        directionB: 'B_TO_A',
        programA: 'RAYDIUM_AMM_V4',
        programB: 'ORCA_WHIRLPOOL',
        dexA: 'RAYDIUM_AMM',
        dexB: 'ORCA_WHIRLPOOL',
        cycleType: '2_LEG',
        orderedPoolIds: ['poolA', 'poolB'],
        orderedTokens: ['token1', 'token2'],
        lastProfitUSDC: 0,
        historicalSuccessCount: 0,
        historicalFailureCount: 0,
        state: 'BLOCKED',
        consecutiveRejections: 0,
        stateTransitionHistory: []
      },
      {
        routeId: 'poolB->poolC',
        poolAId: 'poolB',
        poolBId: 'poolC',
        tokenInMint: 'token2',
        tokenOutMint: 'token3',
        directionA: 'A_TO_B',
        directionB: 'B_TO_A',
        programA: 'ORCA_WHIRLPOOL',
        programB: 'RAYDIUM_CLMM',
        dexA: 'ORCA_WHIRLPOOL',
        dexB: 'RAYDIUM_CLMM',
        cycleType: '2_LEG',
        orderedPoolIds: ['poolB', 'poolC'],
        orderedTokens: ['token2', 'token3'],
        lastProfitUSDC: 0,
        historicalSuccessCount: 0,
        historicalFailureCount: 0,
        state: 'STALE',
        consecutiveRejections: 0,
        stateTransitionHistory: []
      }
    ];

    routeIndex.reconcilePersistentRoutes(mockPersistentRoutes);

    const totalRoutes = routeIndex.getRouteCount();
    const verified = routeIndex.getRouteCountByState('VERIFIED');
    const ready = routeIndex.getRouteCountByState('READY');
    const stale = routeIndex.getRouteCountByState('STALE');
    const blocked = routeIndex.getRouteCountByState('BLOCKED');
    const unvalidated = routeIndex.getRouteCountByState('UNVALIDATED');

    const sumStateCounts = verified + ready + stale + blocked + unvalidated;
    expect(totalRoutes).toBe(2);
    expect(sumStateCounts).toBe(2);
    expect(totalRoutes - sumStateCounts).toBe(0);
    expect(blocked).toBe(1);
    expect(stale).toBe(1);
  });

  it('2. Startup readiness telemetry: reports STANDBY before initialization and RUNNING after', async () => {
    const config = loadConfig();
    config.DB_PATH = testDb;

    // Mock WS provider to verify staged startup
    const mockWs: any = {
      connect: async () => {},
      disconnect: () => {},
      getHealth: () => 'HEALTHY',
      getConnectionStage: () => 'CONNECTED',
      getConnectionState: () => 'CONNECTED',
      getCurrentSlot: () => 312000000,
      getStats: () => ({
        connected: true,
        subscriptionCount: 2,
        confirmedSubscriptionCount: 2,
        rejectedSubscriptionCount: 0
      }),
      onSlot: () => {},
      onAccountUpdate: () => {},
      onDisconnect: () => {},
      onReconnect: () => {},
      setHydratingPools: () => {},
      setSlot: () => {},
      subscribeAccount: () => true
    };

    // Mock RPC provider
    const mockRpc: any = {
      getStats: () => ({ requestsTotal: 1, requestsFailed: 0 }),
      getMultipleAccountsAndContext: async () => ({ slot: 312000000, value: [] })
    };

    const scanner = new ArbitrageScanner(config, mockRpc, mockWs);

    // Initial state before start()
    expect(scanner.isScannerInitialized()).toBe(false);
    expect(scanner.getInitializationStage()).toBe('UNINITIALIZED');
    let hudData = scanner.getHudV2Data();
    expect(hudData.scannerStatus).toBe('OFFLINE');
    expect(hudData.scannerOnline).toBe(false);

    // Run start()
    await scanner.start();

    // After start()
    expect(scanner.isScannerRunning()).toBe(true);
    expect(scanner.isScannerInitialized()).toBe(true);
    expect(scanner.getInitializationStage()).toBe('READY');

    hudData = scanner.getHudV2Data();
    expect(hudData.scannerStatus).toBe('RUNNING');
    expect(hudData.scannerOnline).toBe(true);
    expect(hudData.initializationStage).toBe('READY');

    const timings = scanner.getInitializationTimings();
    expect(timings.elapsedMs['TOTAL_INITIALIZATION']).toBeGreaterThanOrEqual(0);
    expect(timings.rpcFailures['TOTAL']).toBe(0);

    scanner.stop();
    expect(scanner.isScannerRunning()).toBe(false);
    expect(scanner.isScannerInitialized()).toBe(false);
  });
});
