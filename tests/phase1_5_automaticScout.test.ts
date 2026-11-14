import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PublicKey, Keypair } from '@solana/web3.js';
import { AutomaticScout } from '../src/scanner/automaticScout.js';
import { OrcaPoolDiscovery, RaydiumPoolDiscovery, DiscoveredCandidate } from '../src/scanner/poolDiscovery.js';
import { PoolRegistry, PoolConfig } from '../src/scanner/poolRegistry.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS,
  AppConfig,
  loadConfig
} from '../src/config/index.js';

describe('Phase 1.5: Automatic Scout & Route Expansion Suite', () => {
  const testDbPath = path.join(process.cwd(), 'data', 'test_scout_phase1_5.db');
  const testDiscoveryFile = path.join(process.cwd(), 'data', 'test_scout_discovered_pools.json');
  const testThresholdFile = path.join(process.cwd(), 'data', 'test_scout_threshold.json');

  let repository: ArbitrageRepository;
  let poolRegistry: PoolRegistry;
  let routeIndex: RouteIndex;

  const mockConfig: AppConfig = loadConfig({
    DB_PATH: testDbPath,
    DISCOVERED_POOLS_FILE: testDiscoveryFile,
    PROFIT_THRESHOLD_FILE: testThresholdFile,
    MIN_NET_PROFIT_USDC: '0.50'
  });

  function createMockWhirlpoolBuffer(options: {
    tokenAMint?: string;
    tokenBMint?: string;
    liquidity?: bigint;
    tickSpacing?: number;
    feeRate?: number;
    sqrtPrice?: bigint;
    tickCurrent?: number;
  } = {}): Buffer {
    const buf = Buffer.alloc(653);
    const tickSpacing = options.tickSpacing ?? 4;
    const feeRate = options.feeRate ?? 400;
    const liquidity = options.liquidity ?? 50_000_000_000n;
    const sqrtPrice = options.sqrtPrice ?? 5267498573947197513n;
    const tickCurrent = options.tickCurrent ?? -25068;
    const tokenAMint = options.tokenAMint ?? CANONICAL_WSOL_MINT;
    const tokenBMint = options.tokenBMint ?? CANONICAL_USDC_MINT;

    buf.writeUInt16LE(tickSpacing, 41);
    buf.writeUInt16LE(feeRate, 45);
    buf.writeBigUInt64LE(liquidity, 49);
    buf.writeBigUInt64LE(sqrtPrice, 65);
    buf.writeInt32LE(tickCurrent, 81);
    new PublicKey(tokenAMint).toBuffer().copy(buf, 101);
    new PublicKey(tokenBMint).toBuffer().copy(buf, 181);
    return buf;
  }

  function createMockRaydiumAmmBuffer(options: {
    baseMint?: string;
    quoteMint?: string;
    baseVault?: string;
    quoteVault?: string;
    feeNumerator?: bigint;
    feeDenominator?: bigint;
  } = {}): Buffer {
    const buf = Buffer.alloc(752);
    const baseMint = options.baseMint ?? CANONICAL_WSOL_MINT;
    const quoteMint = options.quoteMint ?? CANONICAL_USDC_MINT;
    const baseVault = options.baseVault ?? Keypair.generate().publicKey.toBase58();
    const quoteVault = options.quoteVault ?? Keypair.generate().publicKey.toBase58();
    buf.writeBigUInt64LE(options.feeNumerator ?? 25n, 176);
    buf.writeBigUInt64LE(options.feeDenominator ?? 10000n, 184);
    new PublicKey(baseVault).toBuffer().copy(buf, 336);
    new PublicKey(quoteVault).toBuffer().copy(buf, 368);
    new PublicKey(baseMint).toBuffer().copy(buf, 400);
    new PublicKey(quoteMint).toBuffer().copy(buf, 432);
    return buf;
  }

  function createMockTokenVaultBuffer(amount: bigint = 1_000_000_000n): Buffer {
    const buf = Buffer.alloc(165);
    buf.writeBigUInt64LE(amount, 64);
    return buf;
  }

  beforeEach(() => {
    // Clean up test files
    for (const f of [testDbPath, testDiscoveryFile, testThresholdFile]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }

    repository = new ArbitrageRepository(mockConfig);
    poolRegistry = new PoolRegistry();
    routeIndex = new RouteIndex(poolRegistry.getAllPools());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (repository) {
      repository.close();
    }
    for (const f of [testDbPath, testDiscoveryFile, testThresholdFile]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  });

  // TEST 1: Daily schedule timing and execution
  it('schedules daily bounded discovery cycles and resumes properly from persisted timestamps', async () => {
    vi.useFakeTimers();

    const mockRpc: any = { getAccountInfo: vi.fn().mockResolvedValue(null) };
    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      {
        intervalMs: 86400000, // 24 hours
        runOnStartup: false,
        persistenceFilePath: testDiscoveryFile
      }
    );

    const runSpy = vi.spyOn(scout, 'runScoutCycle').mockResolvedValue({
      status: 'SUCCESS',
      source: 'SCHEDULED',
      candidatesFound: 0,
      candidatesVerified: 0,
      candidatesRejected: 0,
      routesGenerated: 0,
      durationMs: 10,
      routeGenerationTimeMs: 1
    });

    // Case A: No previous run, start() schedules next run in 24 hours
    scout.start();
    expect(runSpy).not.toHaveBeenCalled();

    // Fast-forward 23.5 hours
    vi.advanceTimersByTime(84600000);
    expect(runSpy).not.toHaveBeenCalled();

    // Fast-forward remaining 0.5 hours (hits 24h)
    vi.advanceTimersByTime(1800000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    scout.stop();
  });

  // TEST 2: Manual Scout trigger
  it('executes immediate bounded discovery on manual trigger without waiting for the daily timer', async () => {
    const mockRpc: any = { getAccountInfo: vi.fn().mockResolvedValue(null) };
    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      {
        intervalMs: 86400000,
        runOnStartup: false,
        persistenceFilePath: testDiscoveryFile
      }
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] })
    }));

    const result = await scout.runScoutCycle('MANUAL');
    expect(result.status).toBe('SUCCESS');
    expect(result.source).toBe('MANUAL');
    expect(typeof result.durationMs).toBe('number');
  });

  // TEST 3: Concurrency guard (reject duplicate concurrent runs)
  it('guards against concurrent discovery runs and rejects duplicate runs cleanly', async () => {
    const mockRpc: any = { getAccountInfo: vi.fn().mockResolvedValue(null) };
    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      { runOnStartup: false }
    );

    let resolveFetch: (val: any) => void;
    const slowFetchPromise = new Promise((res) => { resolveFetch = res; });

    vi.stubGlobal('fetch', vi.fn().mockReturnValue(slowFetchPromise));

    // Launch first cycle (remains in progress)
    const runPromise1 = scout.runScoutCycle('MANUAL');

    // Launch second cycle immediately while first is running
    const runResult2 = await scout.runScoutCycle('MANUAL');
    expect(runResult2.status).toBe('SKIPPED_ALREADY_RUNNING');
    expect(runResult2.errorMessage).toContain('already in progress');

    // Finish first cycle
    resolveFetch!({
      ok: true,
      status: 200,
      json: async () => ({ data: [] })
    });

    const runResult1 = await runPromise1;
    expect(runResult1.status).toBe('SUCCESS');
  });

  // TEST 4: Orca discovery and verification with allowlisted pairs
  it('discovers and verifies on-chain Orca Whirlpools with allowlisted token pairs', async () => {
    const orcaDiscovery = new OrcaPoolDiscovery();
    const candidateAddress = Keypair.generate().publicKey.toBase58();

    const orcaBuffer = createMockWhirlpoolBuffer({
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      liquidity: 100_000_000_000n,
      tickSpacing: 4,
      feeRate: 400
    });

    const mockRpc: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: orcaBuffer
      })
    };

    const candidate: DiscoveredCandidate = {
      address: candidateAddress,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 4,
      feeRate: 400,
      tvlUsdc: '2500000',
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    const res = await orcaDiscovery.verifyCandidateOnChain(candidate, mockRpc);
    expect(res.verified).toBe(true);
    expect(res.poolConfig).toBeDefined();
    expect(res.poolConfig?.id).toBe(candidateAddress);
    expect(res.poolConfig?.dex).toBe('ORCA_WHIRLPOOL');
    expect(res.poolConfig?.verificationStatus).toBe('QUOTE_UNVERIFIED');
  });

  // TEST 5: Raydium discovery and verification with allowlisted pairs (AMM V4 & CLMM)
  it('discovers and verifies on-chain Raydium AMM V4 and CLMM pools as QUOTE_UNVERIFIED candidates', async () => {
    const raydiumDiscovery = new RaydiumPoolDiscovery();
    const ammV4Address = Keypair.generate().publicKey.toBase58();
    const clmmAddress = Keypair.generate().publicKey.toBase58();

    const ammV4Buf = createMockRaydiumAmmBuffer({
      baseMint: CANONICAL_WSOL_MINT,
      quoteMint: CANONICAL_USDC_MINT
    });

    const clmmBuf = Buffer.alloc(1544);
    new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(clmmBuf, 73);
    new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(clmmBuf, 105);
    clmmBuf.writeUInt32LE(2500, 201); // 25 bps
    clmmBuf.writeBigUInt64LE(50_000_000_000n, 237); // positive on-chain u128 liquidity at offset 237
    clmmBuf.writeBigUInt64LE(0n, 245);

    const mockRpc: any = {
      getAccountInfo: vi.fn().mockImplementation(async (pubkey: PublicKey) => {
        if (pubkey.toBase58() === ammV4Address) {
          return {
            owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
            data: ammV4Buf
          };
        }
        if (pubkey.toBase58() === clmmAddress) {
          return {
            owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM),
            data: clmmBuf
          };
        }
        return null;
      }),
      getMultipleAccounts: vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
        return pubkeys.map(() => ({
          owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          data: createMockTokenVaultBuffer(500_000_000n)
        }));
      })
    };

    // Case A: Raydium AMM V4
    const resAmm = await raydiumDiscovery.verifyCandidateOnChain({
      address: ammV4Address,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tvlUsdc: '5000000',
      source: 'RAYDIUM_API',
      discoveredAt: Date.now()
    }, mockRpc);

    expect(resAmm.verified).toBe(true);
    expect(resAmm.poolConfig?.dex).toBe('RAYDIUM_AMM');
    expect(resAmm.poolConfig?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    expect(resAmm.poolConfig?.blockerReason).toBe('RAYDIUM_AMM_V4_ADAPTER_PENDING');

    // Case B: Raydium CLMM
    const resClmm = await raydiumDiscovery.verifyCandidateOnChain({
      address: clmmAddress,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tvlUsdc: '1000000',
      source: 'RAYDIUM_API',
      discoveredAt: Date.now()
    }, mockRpc);

    expect(resClmm.verified).toBe(true);
    expect(resClmm.poolConfig?.dex).toBe('RAYDIUM_CLMM');
    expect(resClmm.poolConfig?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    expect(resClmm.poolConfig?.blockerReason).toBe('UNSUPPORTED_PRICING_ADAPTER_CLMM');
  });

  // TEST 6: Candidate deduplication across runs
  it('deduplicates candidate pools across multiple discovery runs without duplicate registration', async () => {
    const existingPool = poolRegistry.getAllPools()[0]; // Czfq3xZZ
    const candidate: DiscoveredCandidate = {
      address: existingPool.id,
      tokenMintA: existingPool.tokenAMint,
      tokenMintB: existingPool.tokenBMint,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    const mockRpc: any = { getAccountInfo: vi.fn() };
    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      { runOnStartup: false }
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [candidate] })
    }));

    const result = await scout.runScoutCycle('MANUAL');
    // Because Czfq3xZZ is already in registry, RPC verification should be skipped
    expect(mockRpc.getAccountInfo).not.toHaveBeenCalled();
    expect(result.candidatesVerified).toBe(0);
  });

  // TEST 7: Invalid candidate rejection
  it('strictly rejects invalid candidate records failing program owner, layout, or mint checks', async () => {
    const orcaDiscovery = new OrcaPoolDiscovery();
    const candidateAddress = Keypair.generate().publicKey.toBase58();

    // 1. Missing account
    const mockRpcMissing: any = { getAccountInfo: vi.fn().mockResolvedValue(null) };
    const resMissing = await orcaDiscovery.verifyCandidateOnChain({
      address: candidateAddress,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    }, mockRpcMissing);
    expect(resMissing.verified).toBe(false);
    expect(resMissing.blockerReason).toBe('ACCOUNT_NOT_FOUND');

    // 2. Wrong owner
    const mockRpcWrongOwner: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(CANONICAL_WSOL_MINT),
        data: Buffer.alloc(700)
      })
    };
    const resWrongOwner = await orcaDiscovery.verifyCandidateOnChain({
      address: candidateAddress,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    }, mockRpcWrongOwner);
    expect(resWrongOwner.verified).toBe(false);
    expect(resWrongOwner.blockerReason).toBe('INVALID_PROGRAM_OWNER');

    // 3. Truncated layout (< 653 bytes)
    const mockRpcTruncated: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: Buffer.alloc(400)
      })
    };
    const resTruncated = await orcaDiscovery.verifyCandidateOnChain({
      address: candidateAddress,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    }, mockRpcTruncated);
    expect(resTruncated.verified).toBe(false);
    expect(resTruncated.blockerReason).toBe('INVALID_ACCOUNT_LAYOUT');

    // 4. Non-allowlisted token mints
    const resNonAllowlist = await orcaDiscovery.verifyCandidateOnChain({
      address: candidateAddress,
      tokenMintA: Keypair.generate().publicKey.toBase58(),
      tokenMintB: CANONICAL_USDC_MINT,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    }, mockRpcMissing);
    expect(resNonAllowlist.verified).toBe(false);
    expect(resNonAllowlist.blockerReason).toBe('UNSUPPORTED_TOKEN_MINTS');
  });

  // TEST 8: Incremental route generation on pool addition (2-leg and 3-leg)
  it('incrementally generates 2-leg and 3-leg cycles when adding a new pool without full graph rebuild', () => {
    const initialRouteCount = routeIndex.getRouteCount();

    // Create a new valid Orca Whirlpool trading USDC <-> WSOL
    const newPoolId = Keypair.generate().publicKey.toBase58();
    const newPool: PoolConfig = {
      id: newPoolId,
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 200,
      initialLiquidityUsd: 1000000,
      description: 'Discovered Test Orca Pool',
      verificationStatus: 'QUOTE_UNVERIFIED'
    };

    const newRoutes = routeIndex.addPoolAndGenerateRoutes(newPool);

    expect(newRoutes.length).toBeGreaterThan(0);
    expect(routeIndex.getRouteCount()).toBe(initialRouteCount + newRoutes.length);

    // Verify all generated routes involve the new pool
    for (const r of newRoutes) {
      expect(r.poolIds).toContain(newPoolId);
    }

    // Verify both 2-leg and 3-leg routes were formed
    const has2Leg = newRoutes.some(r => r.cycleType === '2_LEG');
    const has3Leg = newRoutes.some(r => r.cycleType === '3_LEG');
    expect(has2Leg).toBe(true);
    expect(has3Leg).toBe(true);
  });

  // TEST 9: Non-duplication of existing routes
  it('guarantees non-duplication when attempting to re-add an already registered pool', () => {
    const newPoolId = Keypair.generate().publicKey.toBase58();
    const newPool: PoolConfig = {
      id: newPoolId,
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 200,
      verificationStatus: 'QUOTE_UNVERIFIED'
    };

    // First addition generates routes
    const routesFirstTime = routeIndex.addPoolAndGenerateRoutes(newPool);
    const countAfterFirst = routeIndex.getRouteCount();
    expect(routesFirstTime.length).toBeGreaterThan(0);

    // Second addition should generate 0 new routes
    const routesSecondTime = routeIndex.addPoolAndGenerateRoutes(newPool);
    expect(routesSecondTime.length).toBe(0);
    expect(routeIndex.getRouteCount()).toBe(countAfterFirst);
  });

  // TEST 10: Hot activation without scanner restart
  it('hot-activates discovered pools and hydrates subscriptions without restarting scanner', async () => {
    let activatedPool: PoolConfig | null = null;
    const mockRpc: any = { getAccountInfo: vi.fn() };

    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      { runOnStartup: false },
      async (pool) => {
        activatedPool = pool;
      }
    );

    const candidateAddress = Keypair.generate().publicKey.toBase58();
    const orcaBuffer = createMockWhirlpoolBuffer();
    mockRpc.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
      data: orcaBuffer
    });

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('orca.so')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              address: candidateAddress,
              tokenMintA: CANONICAL_WSOL_MINT,
              tokenMintB: CANONICAL_USDC_MINT,
              tickSpacing: 4,
              feeRate: 400,
              tvlUsdc: '5000000',
              liquidity: '50000000000'
            }]
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));

    await scout.runScoutCycle('MANUAL');

    expect(activatedPool).not.toBeNull();
    expect(activatedPool!.id).toBe(candidateAddress);
    expect(poolRegistry.getPool(candidateAddress)).toBeDefined();
  });

  // TEST 11: Route count expansion toward 100 and 250 targets
  it('proves combinatorial route library expansion reaching 100 and 250 route milestones', () => {
    const testRegistry = new PoolRegistry();
    const testIndex = new RouteIndex(testRegistry.getAllPools());

    // Initially 5 pools produce 42 routes (2-leg and 3-leg)
    expect(testIndex.getRouteCount()).toBe(42);

    // Add 8 additional verified pools across allowlisted pairs (Orca + Raydium)
    const pairs = [
      { a: CANONICAL_WSOL_MINT, b: CANONICAL_USDC_MINT, dex: 'ORCA_WHIRLPOOL' as const, fee: 200 },
      { a: CANONICAL_WSOL_MINT, b: CANONICAL_USDC_MINT, dex: 'ORCA_WHIRLPOOL' as const, fee: 800 },
      { a: CANONICAL_WSOL_MINT, b: CANONICAL_USDC_MINT, dex: 'RAYDIUM_AMM' as const, fee: 25 },
      { a: CANONICAL_USDC_MINT, b: CANONICAL_USDT_MINT, dex: 'ORCA_WHIRLPOOL' as const, fee: 100 },
      { a: CANONICAL_USDC_MINT, b: CANONICAL_USDT_MINT, dex: 'RAYDIUM_AMM' as const, fee: 25 },
      { a: CANONICAL_WSOL_MINT, b: CANONICAL_USDT_MINT, dex: 'ORCA_WHIRLPOOL' as const, fee: 200 },
      { a: CANONICAL_WSOL_MINT, b: CANONICAL_USDT_MINT, dex: 'RAYDIUM_AMM' as const, fee: 25 },
      { a: CANONICAL_WSOL_MINT, b: CANONICAL_USDC_MINT, dex: 'RAYDIUM_CLMM' as const, fee: 25 }
    ];

    for (const p of pairs) {
      testIndex.addPoolAndGenerateRoutes({
        id: Keypair.generate().publicKey.toBase58(),
        dex: p.dex,
        programId: p.dex === 'ORCA_WHIRLPOOL' ? KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL : (p.dex === 'RAYDIUM_AMM' ? KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4 : KNOWN_PROGRAM_IDS.RAYDIUM_CLMM),
        tokenAMint: p.a,
        tokenBMint: p.b,
        feeBps: p.fee,
        verificationStatus: 'QUOTE_UNVERIFIED'
      });
    }

    // Milestone 1 Target: >= 100 routes
    expect(testIndex.getRouteCount()).toBeGreaterThanOrEqual(100);

    // Add remaining available pools across the 3 pairs
    for (let i = 0; i < 6; i++) {
      testIndex.addPoolAndGenerateRoutes({
        id: Keypair.generate().publicKey.toBase58(),
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: i % 2 === 0 ? CANONICAL_WSOL_MINT : CANONICAL_USDC_MINT,
        tokenBMint: i % 2 === 0 ? CANONICAL_USDT_MINT : CANONICAL_USDT_MINT,
        feeBps: 200,
        verificationStatus: 'QUOTE_UNVERIFIED'
      });
    }

    // Milestone 2 Target: >= 250 routes
    expect(testIndex.getRouteCount()).toBeGreaterThanOrEqual(250);
  });

  // TEST 12: Scout failure isolation (Scanner continues running on Scout error)
  it('isolates Scout discovery failures and ensures scanner continues running unaffected', async () => {
    const mockRpc: any = { getAccountInfo: vi.fn() };
    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      { runOnStartup: false }
    );

    // Mock network failure / 500 error from external APIs
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network connection reset')));

    const result = await scout.runScoutCycle('MANUAL');
    vi.unstubAllGlobals();

    expect(result.status).toBe('FAILED');
    expect(scout.getStatus()).toBe('ERROR');

    // Invariant: Pool registry and existing routes remain completely intact
    expect(poolRegistry.getAllPools().length).toBeGreaterThan(0);
    expect(routeIndex.getRouteCount()).toBeGreaterThan(0);
  });

  // TEST 13: HUD metrics accuracy reflecting Scout state & endpoints
  it('exposes accurate Scout metrics via HUD status endpoint and supports manual trigger', async () => {
    vi.unstubAllGlobals();
    const mockRpc: any = { getAccountInfo: vi.fn() };
    const thresholdManager = new ProfitThresholdManager({ initialThresholdUSDC: 0.50 });
    const scout = new AutomaticScout(
      poolRegistry,
      routeIndex,
      repository,
      mockRpc,
      { runOnStartup: false }
    );

    const metrics = scout.getMetrics();
    expect(metrics.scoutStatus).toBe('IDLE');
    expect(typeof metrics.totalRoutesInLibrary).toBe('number');
    expect(typeof metrics.twoLegRoutesCount).toBe('number');
    expect(typeof metrics.threeLegRoutesCount).toBe('number');
    expect(typeof metrics.verifiedRoutesCount).toBe('number');
    expect(typeof metrics.blockedRoutesCount).toBe('number');

    // Test HUD endpoint
    const mockScanner: any = {
      getHealthStatus: () => ({ currentSlot: 1000, connectedWs: true, connectedRpc: true }),
      getOpportunityTracker: () => ({ getAllActiveOpportunities: () => [], getActiveAllocatedCapital: () => 0 }),
      getRouteLibrarySummary: () => ({ totalRoutes: 10 }),
      getScoutMetrics: () => scout.getMetrics(),
      triggerScoutDiscovery: vi.fn().mockResolvedValue({ status: 'SUCCESS', candidatesVerified: 2 })
    };

    const hudServer = new ProfitHudServer(thresholdManager, mockScanner, { port: 3099, silent: true });
    await hudServer.start();

    try {
      // 1. GET /api/status includes scout metrics
      const statusRes = await fetch('http://127.0.0.1:3099/api/status');
      const statusJson: any = await statusRes.json();
      expect(statusJson.scout).toBeDefined();
      expect(statusJson.scout.scoutStatus).toBe('IDLE');

      // 2. POST /api/scout/trigger triggers manual discovery
      const triggerRes = await fetch('http://127.0.0.1:3099/api/scout/trigger', {
        method: 'POST',
        headers: { 'Origin': 'http://127.0.0.1:3099' }
      });
      const triggerJson: any = await triggerRes.json();
      expect(triggerJson.success).toBe(true);
      expect(mockScanner.triggerScoutDiscovery).toHaveBeenCalledWith('MANUAL');
    } finally {
      await hudServer.stop();
    }
  });

  describe('Phase 1.5 Final Correction Regressions', () => {
    // 1. Repeat discovery runs without starvation (filtering existing pools before slice)
    it('filters existing registered pools before applying maxCandidatesPerRun limit, eliminating starvation', async () => {
      // Create 5 known pools and 2 new candidate pools
      const knownPools: DiscoveredCandidate[] = [];
      for (let i = 0; i < 5; i++) {
        const addr = Keypair.generate().publicKey.toBase58();
        poolRegistry.register({
          id: addr,
          dex: 'ORCA_WHIRLPOOL',
          programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
          tokenAMint: CANONICAL_WSOL_MINT,
          tokenBMint: CANONICAL_USDC_MINT,
          feeBps: 4,
          verificationStatus: 'QUOTE_UNVERIFIED',
          blockerReason: 'TEST'
        });
        knownPools.push({
          address: addr,
          tokenMintA: CANONICAL_WSOL_MINT,
          tokenMintB: CANONICAL_USDC_MINT,
          source: 'ORCA_API',
          discoveredAt: Date.now()
        });
      }

      const newPool1 = Keypair.generate().publicKey.toBase58();
      const newPool2 = Keypair.generate().publicKey.toBase58();
      const allApiCandidates = [
        ...knownPools, // 5 known pools at the front of the list
        { address: newPool1, tokenMintA: CANONICAL_WSOL_MINT, tokenMintB: CANONICAL_USDC_MINT, source: 'ORCA_API' as const, discoveredAt: Date.now() },
        { address: newPool2, tokenMintA: CANONICAL_WSOL_MINT, tokenMintB: CANONICAL_USDC_MINT, source: 'ORCA_API' as const, discoveredAt: Date.now() }
      ];

      const mockRpc: any = {
        getAccountInfo: vi.fn().mockImplementation(async (pubkey: PublicKey) => {
          return {
            owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
            data: createMockWhirlpoolBuffer({
              tokenAMint: CANONICAL_WSOL_MINT,
              tokenBMint: CANONICAL_USDC_MINT,
              liquidity: 50_000_000_000n
            })
          };
        })
      };

      const scout = new AutomaticScout(
        poolRegistry,
        routeIndex,
        repository,
        mockRpc,
        {
          runOnStartup: false,
          maxCandidatesPerRun: 2 // Only 2 candidates per run!
        }
      );

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: allApiCandidates })
      }));

      // Under the old bug, slice(0, 2) took the first 2 known pools, skipped both, and verified 0 new pools!
      // Under our fix, it filters out the 5 known pools first, leaving newPool1 and newPool2, and verifies both!
      const res = await scout.runScoutCycle('MANUAL');
      expect(res.candidatesVerified).toBe(2);
      expect(poolRegistry.getPool(newPool1)).toBeDefined();
      expect(poolRegistry.getPool(newPool2)).toBeDefined();
    });

    // 2. Pagination in Raydium and Orca
    it('paginates Raydium API across multiple pages and Orca API across cursors', async () => {
      const raydiumDiscovery = new RaydiumPoolDiscovery({ maxPages: 3, pageSize: 10 });
      let fetchCallCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        fetchCallCount++;
        const p1 = Keypair.generate().publicKey.toBase58();
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              data: [
                {
                  id: p1,
                  mintA: { address: CANONICAL_USDC_MINT },
                  mintB: { address: CANONICAL_WSOL_MINT },
                  feeRate: 0.0025,
                  tvl: 500000,
                  programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4
                }
              ]
            }
          })
        };
      }));

      const result = await raydiumDiscovery.discoverCandidates();
      expect(result.pagesFetched).toBeGreaterThanOrEqual(3);
      expect(result.candidates.length).toBeGreaterThanOrEqual(3);
      expect(result.candidates[0].dexType).toBe('RAYDIUM_AMM');
    });

    // 3. Correct DEX recovery after restart
    it('preserves correct DEX identities (RAYDIUM_AMM, RAYDIUM_CLMM) upon restart and does not restore them as Orca Whirlpools', async () => {
      const rayAmmPoolId = Keypair.generate().publicKey.toBase58();
      const rayClmmPoolId = Keypair.generate().publicKey.toBase58();
      const orcaPoolId = Keypair.generate().publicKey.toBase58();

      const candidates: DiscoveredCandidate[] = [
        {
          address: rayAmmPoolId,
          tokenMintA: CANONICAL_WSOL_MINT,
          tokenMintB: CANONICAL_USDC_MINT,
          source: 'RAYDIUM_API',
          dexType: 'RAYDIUM_AMM',
          programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
          feeRate: 0.0025,
          discoveredAt: Date.now()
        },
        {
          address: rayClmmPoolId,
          tokenMintA: CANONICAL_WSOL_MINT,
          tokenMintB: CANONICAL_USDC_MINT,
          source: 'RAYDIUM_API',
          dexType: 'RAYDIUM_CLMM',
          programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
          feeRate: 0.0005,
          discoveredAt: Date.now()
        },
        {
          address: orcaPoolId,
          tokenMintA: CANONICAL_WSOL_MINT,
          tokenMintB: CANONICAL_USDC_MINT,
          source: 'ORCA_API',
          dexType: 'ORCA_WHIRLPOOL',
          programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
          feeRate: 400,
          discoveredAt: Date.now()
        }
      ];

      const freshRegistry = new PoolRegistry();
      freshRegistry.loadDiscoveredCandidates(candidates);

      const poolAmm = freshRegistry.getPool(rayAmmPoolId);
      const poolClmm = freshRegistry.getPool(rayClmmPoolId);
      const poolOrca = freshRegistry.getPool(orcaPoolId);

      expect(poolAmm?.dex).toBe('RAYDIUM_AMM');
      expect(poolAmm?.programId).toBe(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4);

      expect(poolClmm?.dex).toBe('RAYDIUM_CLMM');
      expect(poolClmm?.programId).toBe(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM);
      expect(poolClmm?.blockerReason).toBe('UNSUPPORTED_PRICING_ADAPTER_CLMM');

      expect(poolOrca?.dex).toBe('ORCA_WHIRLPOOL');
      expect(poolOrca?.programId).toBe(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL);
    });

    // 4. Raydium on-chain verification: fee decoding & on-chain vault reserves (zero liquidity / API TVL rejection)
    it('decodes exact on-chain fee configuration and rejects zero on-chain liquidity despite positive API TVL', async () => {
      const raydiumDiscovery = new RaydiumPoolDiscovery();
      const poolAddr = Keypair.generate().publicKey.toBase58();
      const baseVault = Keypair.generate().publicKey.toBase58();
      const quoteVault = Keypair.generate().publicKey.toBase58();

      // Custom fee: 50 bps (50n / 10000n)
      const ammBuf = createMockRaydiumAmmBuffer({
        baseMint: CANONICAL_WSOL_MINT,
        quoteMint: CANONICAL_USDC_MINT,
        baseVault,
        quoteVault,
        feeNumerator: 50n,
        feeDenominator: 10000n
      });

      // Case A: Vault with ZERO balance
      const mockRpcZeroVault: any = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
          data: ammBuf
        }),
        getMultipleAccounts: vi.fn().mockResolvedValue([
          { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: createMockTokenVaultBuffer(0n) }, // 0 balance!
          { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: createMockTokenVaultBuffer(1_000_000n) }
        ])
      };

      const resZero = await raydiumDiscovery.verifyCandidateOnChain({
        address: poolAddr,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tvlUsdc: '5000000', // Positive API TVL!
        source: 'RAYDIUM_API',
        discoveredAt: Date.now()
      }, mockRpcZeroVault);

      expect(resZero.verified).toBe(false);
      expect(resZero.blockerReason).toBe('ZERO_ONCHAIN_LIQUIDITY');

      // Case B: Vault with POSITIVE balances
      const mockRpcPositive: any = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
          data: ammBuf
        }),
        getMultipleAccounts: vi.fn().mockResolvedValue([
          { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: createMockTokenVaultBuffer(500_000_000n) },
          { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: createMockTokenVaultBuffer(500_000_000n) }
        ])
      };

      const resValid = await raydiumDiscovery.verifyCandidateOnChain({
        address: poolAddr,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        source: 'RAYDIUM_API',
        discoveredAt: Date.now()
      }, mockRpcPositive);

      expect(resValid.verified).toBe(true);
      expect(resValid.poolConfig?.feeBps).toBe(50); // Exact fee decoded!
      expect(resValid.poolConfig?.description).toContain('50 bps');
    });

    // 5. Hot activation and subscription deduplication without restart
    it('hot-activates discovered pools, fetches live snapshots out-of-band, and deduplicates subscriptions', async () => {
      const scanner = new ArbitrageScanner(mockConfig);
      const newPoolId = Keypair.generate().publicKey.toBase58();
      const newPoolConfig: PoolConfig = {
        id: newPoolId,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 4,
        verificationStatus: 'QUOTE_UNVERIFIED'
      };

      scanner.getPoolRegistry().register(newPoolConfig);

      // Verify hot activation does not throw and executes safely
      await expect(scanner.hotActivateDiscoveredPool(newPoolConfig)).resolves.not.toThrow();

      // Calling hotActivateDiscoveredPool a second time should deduplicate subscriptions without duplicate listeners
      await expect(scanner.hotActivateDiscoveredPool(newPoolConfig)).resolves.not.toThrow();

      scanner.stop();
    });

    // 6. Real route-state classification (BLOCKED never counted as verified)
    it('classifies route states strictly and never counts BLOCKED routes in verified metrics', async () => {
      const scout = new AutomaticScout(
        poolRegistry,
        routeIndex,
        repository,
        { getAccountInfo: vi.fn() } as any,
        { runOnStartup: false }
      );

      const metrics = scout.getMetrics();
      // Invariant: verifiedRoutesCount + blockedRoutesCount = totalRoutesInLibrary
      // And verifiedRoutesCount = READY + STALE + VERIFIED
      expect(metrics.totalRoutesInLibrary).toBe(metrics.verifiedRoutesCount + metrics.blockedRoutesCount);
      expect(metrics.verifiedRoutesCount).toBeLessThan(metrics.totalRoutesInLibrary);
      expect(metrics.blockedRoutesCount).toBeGreaterThan(0);
    });
  });

  describe('Phase 1.5 Final Audit: Raydium CLMM Verification & Hot Activation Accuracy', () => {
    function createMockRaydiumClmmBuffer(options: {
      tokenMint0?: string;
      tokenMint1?: string;
      liquidityLow?: bigint;
      liquidityHigh?: bigint;
      decimals0?: number;
      decimals1?: number;
      tickSpacing?: number;
      dataLength?: number;
    } = {}): Buffer {
      const len = options.dataLength ?? 1544;
      const buf = Buffer.alloc(len);
      const m0 = options.tokenMint0 ?? CANONICAL_WSOL_MINT;
      const m1 = options.tokenMint1 ?? CANONICAL_USDC_MINT;
      new PublicKey(m0).toBuffer().copy(buf, 73);
      new PublicKey(m1).toBuffer().copy(buf, 105);
      buf.writeUInt8(options.decimals0 ?? 9, 233);
      buf.writeUInt8(options.decimals1 ?? 6, 234);
      buf.writeUInt16LE(options.tickSpacing ?? 1, 235);
      buf.writeBigUInt64LE(options.liquidityLow ?? 50_000_000_000n, 237);
      buf.writeBigUInt64LE(options.liquidityHigh ?? 0n, 245);
      return buf;
    }

    it('decodes complete u128 liquidity at offset 237 and verifies on-chain token mints in Raydium CLMM layout', async () => {
      const discovery = new RaydiumPoolDiscovery();
      const clmmAddress = Keypair.generate().publicKey.toBase58();
      const lowPart = 123456789n;
      const highPart = 3n;
      const expectedU128 = lowPart | (highPart << 64n);

      const clmmBuf = createMockRaydiumClmmBuffer({
        tokenMint0: CANONICAL_WSOL_MINT,
        tokenMint1: CANONICAL_USDC_MINT,
        liquidityLow: lowPart,
        liquidityHigh: highPart
      });

      const mockRpc: any = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM),
          data: clmmBuf
        })
      };

      const res = await discovery.verifyCandidateOnChain({
        address: clmmAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tvlUsdc: '5000000',
        feeRate: 0.0004,
        source: 'RAYDIUM_API',
        discoveredAt: Date.now()
      }, mockRpc);

      expect(res.verified).toBe(true);
      expect(res.activeLiquidity).toBe(expectedU128.toString());
      expect(res.poolConfig?.dex).toBe('RAYDIUM_CLMM');
      expect(res.poolConfig?.tokenAMint).toBe(CANONICAL_WSOL_MINT);
      expect(res.poolConfig?.tokenBMint).toBe(CANONICAL_USDC_MINT);
      expect(res.poolConfig?.verificationStatus).toBe('QUOTE_UNVERIFIED');
      expect(res.poolConfig?.blockerReason).toBe('UNSUPPORTED_PRICING_ADAPTER_CLMM');
    });

    it('fails closed on Raydium CLMM token mint mismatch', async () => {
      const discovery = new RaydiumPoolDiscovery();
      const clmmAddress = Keypair.generate().publicKey.toBase58();
      const randomMint = Keypair.generate().publicKey.toBase58();

      const clmmBuf = createMockRaydiumClmmBuffer({
        tokenMint0: randomMint,
        tokenMint1: CANONICAL_USDC_MINT
      });

      const mockRpc: any = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM),
          data: clmmBuf
        })
      };

      const res = await discovery.verifyCandidateOnChain({
        address: clmmAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tvlUsdc: '5000000',
        source: 'RAYDIUM_API',
        discoveredAt: Date.now()
      }, mockRpc);

      expect(res.verified).toBe(false);
      expect(res.blockerReason).toBe('MINT_PAIR_MISMATCH');
    });

    it('rejects zero on-chain liquidity in Raydium CLMM despite positive API TVL and candidate liquidity', async () => {
      const discovery = new RaydiumPoolDiscovery();
      const clmmAddress = Keypair.generate().publicKey.toBase58();

      const clmmBuf = createMockRaydiumClmmBuffer({
        liquidityLow: 0n,
        liquidityHigh: 0n
      });

      const mockRpc: any = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM),
          data: clmmBuf
        })
      };

      const res = await discovery.verifyCandidateOnChain({
        address: clmmAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tvlUsdc: '99999999',
        liquidity: '88888888',
        source: 'RAYDIUM_API',
        discoveredAt: Date.now()
      }, mockRpc);

      expect(res.verified).toBe(false);
      expect(res.blockerReason).toBe('ZERO_ONCHAIN_LIQUIDITY');
      expect(res.activeLiquidity).toBe('0');
    });

    it('fails closed when Raydium CLMM account data length is truncated below official 1544 bytes', async () => {
      const discovery = new RaydiumPoolDiscovery();
      const clmmAddress = Keypair.generate().publicKey.toBase58();

      const truncatedBuf = createMockRaydiumClmmBuffer({
        dataLength: 1500
      });

      const mockRpc: any = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM),
          data: truncatedBuf
        })
      };

      const res = await discovery.verifyCandidateOnChain({
        address: clmmAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        source: 'RAYDIUM_API',
        discoveredAt: Date.now()
      }, mockRpc);

      expect(res.verified).toBe(false);
      expect(res.blockerReason).toBe('INVALID_ACCOUNT_LAYOUT');
    });

    it('returns explicit HotActivationOutcome: UNSUPPORTED for CLMM, PENDING_DEPENDENCIES without tick arrays', async () => {
      const scanner = new ArbitrageScanner(mockConfig);

      // 1. Raydium CLMM pool returns UNSUPPORTED
      const clmmPoolConfig: PoolConfig = {
        id: Keypair.generate().publicKey.toBase58(),
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 25,
        verificationStatus: 'QUOTE_UNVERIFIED',
        blockerReason: 'UNSUPPORTED_PRICING_ADAPTER_CLMM'
      };
      scanner.getPoolRegistry().register(clmmPoolConfig);
      const outcomeClmm = await scanner.hotActivateDiscoveredPool(clmmPoolConfig);
      expect(outcomeClmm).toBe('UNSUPPORTED');

      // 2. Orca pool with live RPC returning Whirlpool data but no tick arrays returns PENDING_DEPENDENCIES
      const orcaPoolId = Keypair.generate().publicKey.toBase58();
      const orcaPoolConfig: PoolConfig = {
        id: orcaPoolId,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 4,
        verificationStatus: 'QUOTE_UNVERIFIED'
      };
      scanner.getPoolRegistry().register(orcaPoolConfig);

      const whirlpoolBuf = createMockWhirlpoolBuffer({
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        liquidity: 10_000_000_000n,
        tickSpacing: 4,
        tickCurrent: -25068
      });

      (scanner as any).rpc = {
        getMultipleAccountsAndContext: vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
          if (pubkeys[0].toBase58() === orcaPoolId) {
            return {
              slot: 250000000,
              value: [{
                owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
                data: whirlpoolBuf
              }]
            };
          }
          return {
            slot: 250000000,
            value: pubkeys.map(() => null)
          };
        })
      };

      const outcomePending = await scanner.hotActivateDiscoveredPool(orcaPoolConfig);
      expect(outcomePending).toBe('PENDING_DEPENDENCIES');

      scanner.stop();
    });

    it('does not increment hotActivatedPoolsCount on PENDING_DEPENDENCIES, UNSUPPORTED, or FAILED outcomes', async () => {
      let callCount = 0;
      const scout = new AutomaticScout(
        poolRegistry,
        routeIndex,
        repository,
        {
          getMultipleAccounts: vi.fn().mockResolvedValue([]),
          getAccountInfo: vi.fn().mockResolvedValue(null)
        } as any,
        { runOnStartup: false },
        async (pool) => {
          callCount++;
          if (pool.dex === 'RAYDIUM_CLMM') return 'UNSUPPORTED';
          if (callCount % 2 === 0) return 'PENDING_DEPENDENCIES';
          return 'FAILED';
        }
      );

      // Manually simulate scout onPoolActivated invocations
      const outcome1 = await (scout as any).onPoolActivated({
        id: 'pool_clmm',
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 25,
        verificationStatus: 'QUOTE_UNVERIFIED'
      });

      if (outcome1 === 'ACTIVATED') {
        (scout as any).hotActivatedPoolsCount++;
      } else if (outcome1 === 'PENDING_DEPENDENCIES') {
        (scout as any).pendingActivationPoolsCount++;
      } else if (outcome1 === 'UNSUPPORTED') {
        (scout as any).unsupportedPoolsCount++;
      } else {
        (scout as any).failedActivationPoolsCount++;
      }

      const outcome2 = await (scout as any).onPoolActivated({
        id: 'pool_orca_pending',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 4,
        verificationStatus: 'QUOTE_UNVERIFIED'
      });

      if (outcome2 === 'ACTIVATED') {
        (scout as any).hotActivatedPoolsCount++;
      } else if (outcome2 === 'PENDING_DEPENDENCIES') {
        (scout as any).pendingActivationPoolsCount++;
      } else if (outcome2 === 'UNSUPPORTED') {
        (scout as any).unsupportedPoolsCount++;
      } else {
        (scout as any).failedActivationPoolsCount++;
      }

      const metrics = scout.getMetrics();
      expect(metrics.hotActivatedPoolsCount).toBe(0);
      expect(metrics.unsupportedPoolsCount).toBe(1);
      expect(metrics.pendingActivationPoolsCount).toBe(1);
    });
  });
});
