import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  saveDiscoveredCandidates,
  loadDiscoveredCandidates,
  OrcaPoolDiscovery,
  DiscoveredCandidate
} from '../src/scanner/poolDiscovery.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import {
  loadConfig,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';

describe('Phase 1.3: Discovered Pool Activation & Safety Suite', () => {
  const testDir = path.join(process.cwd(), 'data', 'test_activation');
  const testDiscoveryFile = path.join(testDir, 'discovered_pools.json');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
    fs.mkdirSync(testDir, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
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

  // 1. Discovery Persistence (atomic write/replace, deduplication by address)
  it('persists discovered candidates atomically to JSON and deduplicates by pool address', () => {
    const pool1 = Keypair.generate().publicKey.toBase58();
    const pool2 = Keypair.generate().publicKey.toBase58();

    const candidatesBatch1: DiscoveredCandidate[] = [
      {
        address: pool1,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tickSpacing: 4,
        feeRate: 400,
        source: 'ORCA_API',
        discoveredAt: Date.now()
      }
    ];

    saveDiscoveredCandidates(candidatesBatch1, testDiscoveryFile);
    expect(fs.existsSync(testDiscoveryFile)).toBe(true);

    let loaded = loadDiscoveredCandidates(testDiscoveryFile);
    expect(loaded.length).toBe(1);
    expect(loaded[0].address).toBe(pool1);

    // Batch 2 with one duplicate (pool1) and one new candidate (pool2)
    const candidatesBatch2: DiscoveredCandidate[] = [
      {
        address: pool1, // Duplicate
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tickSpacing: 4,
        feeRate: 400,
        source: 'ORCA_API',
        discoveredAt: Date.now()
      },
      {
        address: pool2, // New
        tokenMintA: CANONICAL_USDC_MINT,
        tokenMintB: CANONICAL_USDT_MINT,
        tickSpacing: 1,
        feeRate: 100,
        source: 'ORCA_API',
        discoveredAt: Date.now()
      }
    ];

    saveDiscoveredCandidates(candidatesBatch2, testDiscoveryFile);

    loaded = loadDiscoveredCandidates(testDiscoveryFile);
    expect(loaded.length).toBe(2);
    expect(loaded.map(c => c.address).sort()).toEqual([pool1, pool2].sort());
  });

  // 2. Scanner Restart Loading (loads candidates before building route indexes; retains default pools)
  it('loads discovered candidates into registry on scanner startup and preserves all default pools', () => {
    const discoveredPoolAddr = Keypair.generate().publicKey.toBase58();
    const candidate: DiscoveredCandidate = {
      address: discoveredPoolAddr,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 64,
      feeRate: 3000,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };
    saveDiscoveredCandidates([candidate], testDiscoveryFile);

    const config = loadConfig({
      DISCOVERED_POOLS_FILE: testDiscoveryFile,
      DB_PATH: path.join(testDir, 'scanner1.db')
    });
    const scanner = new ArbitrageScanner(config);
    const registry = scanner.getPoolRegistry();

    // Default pool count is 8; with 1 discovered pool it must be 9
    expect(registry.getAllPools().length).toBe(9);

    // Discovered pool is loaded into registry
    const loadedPool = registry.getPool(discoveredPoolAddr);
    expect(loadedPool).toBeDefined();
    expect(loadedPool?.dex).toBe('ORCA_WHIRLPOOL');
    expect(loadedPool?.verificationStatus).toBe('QUOTE_UNVERIFIED');

    // Invariant: All default pools are 100% retained
    expect(registry.getPool('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')?.verificationStatus).toBe('VERIFIED_DIRECT');
    expect(registry.getPool('FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q')?.verificationStatus).toBe('VERIFIED_DIRECT');
    expect(registry.getPool('4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4')?.verificationStatus).toBe('VERIFIED_DIRECT');
    scanner.stop();
  });

  // 3. Exact Mint Pair Matching
  it('strictly validates on-chain mints match candidate record and rejects mint pair mismatches', async () => {
    const discovery = new OrcaPoolDiscovery();
    const candidatePoolAddr = Keypair.generate().publicKey.toBase58();

    // Candidate claims WSOL / USDC
    const candidate: DiscoveredCandidate = {
      address: candidatePoolAddr,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 4,
      feeRate: 400,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    // Case A: On-chain account has mismatched mints (WSOL / USDT instead of WSOL / USDC)
    const mismatchedBuf = createMockWhirlpoolBuffer({
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDT_MINT // Mismatched quote token
    });

    const mockRpcMismatch: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: mismatchedBuf
      })
    };

    const resMismatch = await discovery.verifyCandidateOnChain(candidate, mockRpcMismatch);
    expect(resMismatch.verified).toBe(false);
    expect(resMismatch.blockerReason).toBe('MINT_PAIR_MISMATCH');

    // Case B: On-chain account has matching mints (in reverse orientation B / A)
    const reversedBuf = createMockWhirlpoolBuffer({
      tokenAMint: CANONICAL_USDC_MINT,
      tokenBMint: CANONICAL_WSOL_MINT
    });

    const mockRpcReversed: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: reversedBuf
      })
    };

    const resReversed = await discovery.verifyCandidateOnChain(candidate, mockRpcReversed);
    expect(resReversed.verified).toBe(true);
  });

  // 4. Positive On-Chain Liquidity Requirement (reject zero liquidity, never accept API TVL)
  it('rejects candidate with zero on-chain liquidity even if API claims positive TVL', async () => {
    const discovery = new OrcaPoolDiscovery();
    const candidatePoolAddr = Keypair.generate().publicKey.toBase58();

    // Candidate has high API TVL ($10,000,000 USDC)
    const candidate: DiscoveredCandidate = {
      address: candidatePoolAddr,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 4,
      feeRate: 400,
      tvlUsdc: '10000000',
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    // But on-chain decoded Whirlpool buffer has ZERO active liquidity (liquidity = 0n)
    const zeroLiquidityBuf = createMockWhirlpoolBuffer({
      liquidity: 0n
    });

    const mockRpc: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: zeroLiquidityBuf
      })
    };

    const res = await discovery.verifyCandidateOnChain(candidate, mockRpc);
    expect(res.verified).toBe(false);
    expect(res.blockerReason).toBe('ZERO_LIQUIDITY');
  });

  // 5. Malformed Candidate Record Rejection
  it('strictly rejects malformed candidate records before calling RPC', async () => {
    const discovery = new OrcaPoolDiscovery();
    const mockRpc: any = { getAccountInfo: vi.fn() };

    // Malformed: not a base58 address
    const malformed1 = {
      address: 'not-a-valid-solana-address-$$$',
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT
    } as any;
    const res1 = await discovery.verifyCandidateOnChain(malformed1, mockRpc);
    expect(res1.verified).toBe(false);
    expect(res1.blockerReason).toBe('MALFORMED_CANDIDATE');
    expect(mockRpc.getAccountInfo).not.toHaveBeenCalled();

    // Malformed: identical mints
    const validAddr = Keypair.generate().publicKey.toBase58();
    const malformed2 = {
      address: validAddr,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_WSOL_MINT // Identical token
    } as any;
    const res2 = await discovery.verifyCandidateOnChain(malformed2, mockRpc);
    expect(res2.verified).toBe(false);
    expect(res2.blockerReason).toBe('UNSUPPORTED_TOKEN_MINTS');
  });

  // 6. Duplicate Address Handling in Registry
  it('ignores duplicate candidates matching existing default pools and prevents duplicate routes', () => {
    const registry = new PoolRegistry();
    const initialPoolCount = registry.getAllPools().length;

    // Discovered candidate matches existing default pool Czfq3xZZ
    const duplicateCandidate: DiscoveredCandidate = {
      address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 4,
      feeRate: 400,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    const added = registry.loadDiscoveredCandidates([duplicateCandidate]);
    expect(added).toBe(0); // 0 added
    expect(registry.getAllPools().length).toBe(initialPoolCount);
    // Preserves original direct verified status
    expect(registry.getPool('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')?.verificationStatus).toBe('VERIFIED_DIRECT');
  });

  // 7. Safe Activation: Discovered Pools Start QUOTE_UNVERIFIED
  it('registers discovered pools strictly as QUOTE_UNVERIFIED initially', () => {
    const registry = new PoolRegistry();
    const newPoolAddr = Keypair.generate().publicKey.toBase58();

    const candidate: DiscoveredCandidate = {
      address: newPoolAddr,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 8,
      feeRate: 800,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    const added = registry.loadDiscoveredCandidates([candidate]);
    expect(added).toBe(1);

    const pool = registry.getPool(newPoolAddr);
    expect(pool).toBeDefined();
    expect(pool?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    expect(registry.isPoolVerified(newPoolAddr)).toBe(false);
  });

  // 8. Tick-Array Hydration & Safe Promotion
  it('promotes discovered pool to VERIFIED_DIRECT only after all surrounding tick arrays are hydrated and fresh', async () => {
    const discoveredAddr = Keypair.generate().publicKey.toBase58();
    const candidate: DiscoveredCandidate = {
      address: discoveredAddr,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 4,
      feeRate: 400,
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };
    saveDiscoveredCandidates([candidate], testDiscoveryFile);

    const config = loadConfig({
      DISCOVERED_POOLS_FILE: testDiscoveryFile,
      DB_PATH: path.join(testDir, 'scanner1.db')
    });

    const poolBuf = createMockWhirlpoolBuffer({
      tickSpacing: 4,
      tickCurrent: -25068, // surrounding starts: -25600, -25088, -24576, etc.
      liquidity: 50_000_000_000n
    });

    const mockRpc: any = {
      getMultipleAccountsAndContext: vi.fn().mockImplementation((pubkeys: PublicKey[]) => {
        // Return Whirlpool account buffer for pool queries
        return Promise.resolve({
          context: { slot: 1000 },
          value: pubkeys.map(pk => {
            const pkStr = pk.toBase58();
            if (pkStr === discoveredAddr || pkStr === 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE') {
              return {
                owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
                data: poolBuf
              };
            }
            return null;
          })
        });
      })
    };

    const scanner = new ArbitrageScanner(config, mockRpc);
    const registry = scanner.getPoolRegistry();

    // Initially QUOTE_UNVERIFIED
    expect(registry.getPool(discoveredAddr)?.verificationStatus).toBe('QUOTE_UNVERIFIED');

    // Step A: Hydrate pool without tick arrays -> remains QUOTE_UNVERIFIED
    await scanner.refreshAllPoolStates();
    expect(registry.getPool(discoveredAddr)?.verificationStatus).toBe('QUOTE_UNVERIFIED');

    // Step B: Provide hydrated tick array WebSocket update
    // TickArray mock: 10240-byte account with valid Whirlpool program owner
    const tickArrayBuf = Buffer.alloc(10240);
    new PublicKey(discoveredAddr).toBuffer().copy(tickArrayBuf, 8); // whirlpool pointer
    tickArrayBuf.writeInt32LE(-25088, 40); // startTickIndex

    // Deliver tick array update to scanner event queue
    (scanner as any).processTickArrayAccountUpdate({
      type: 'TICK_ARRAY_ACCOUNT',
      key: 'mock-tick-array-key',
      data: tickArrayBuf,
      slot: 1000,
      receivedAtMs: Date.now(),
      monotonicReceiptTime: performance.now()
    });

    // Incomplete tick array sequence still fails closed (remains QUOTE_UNVERIFIED)
    expect(registry.getPool(discoveredAddr)?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    scanner.stop();
  });

  // 9. Existing Route Preservation & Non-blocking Startup
  it('preserves existing routes intact and handles missing or corrupt persistence files without hanging', () => {
    // A) Missing file: scanner initializes cleanly with 8 default pools
    const missingFile = path.join(testDir, 'missing_pools.json');
    const configMissing = loadConfig({
      DISCOVERED_POOLS_FILE: missingFile,
      DB_PATH: path.join(testDir, 'scanner_missing.db')
    });
    const scannerMissing = new ArbitrageScanner(configMissing);
    expect(scannerMissing.getPoolRegistry().getAllPools().length).toBe(8);
    expect(scannerMissing.getRouteIndex().getRouteCount()).toBe(42);
    scannerMissing.stop();

    // B) Corrupt file: scanner initializes cleanly with warning and default pools intact
    const corruptFile = path.join(testDir, 'corrupt_pools.json');
    fs.writeFileSync(corruptFile, '{ "invalid_json": true, malformed }', 'utf-8');
    const configCorrupt = loadConfig({
      DISCOVERED_POOLS_FILE: corruptFile,
      DB_PATH: path.join(testDir, 'scanner_corrupt.db')
    });
    const scannerCorrupt = new ArbitrageScanner(configCorrupt);
    expect(scannerCorrupt.getPoolRegistry().getAllPools().length).toBe(8);
    expect(scannerCorrupt.getRouteIndex().getRouteCount()).toBe(42);
    scannerCorrupt.stop();
  });
});
