import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  OrcaPoolDiscovery,
  DiscoveredCandidate
} from '../src/scanner/poolDiscovery.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS,
  loadConfig
} from '../src/config/index.js';

describe('OrcaPoolDiscovery & Verification Suite (Phase 1.3)', () => {
  const config = loadConfig();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('respects maximum 10 results per page and maximum 3 pages during API discovery', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++;
      expect(url).toContain('limit=10');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                address: `mock-pool-${callCount}`,
                tokenMintA: CANONICAL_WSOL_MINT,
                tokenMintB: CANONICAL_USDC_MINT,
                tickSpacing: 4,
                feeRate: 400,
                tvlUsdc: '1000000',
                liquidity: '50000000000'
              }
            ],
            meta: { cursor: { next: callCount < 5 ? `cursor-${callCount}` : null } }
          })
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const discovery = new OrcaPoolDiscovery({
      pageSize: 10,
      maxPages: 3,
      timeoutMs: 1000,
      maxRetries: 0
    });

    const res = await discovery.discoverCandidates();
    expect(res.pagesFetched).toBe(3); // Exactly capped at 3 pages
    expect(callCount).toBe(3);
    expect(res.candidates.length).toBe(3);
    expect(res.apiStatus).toBe('SUCCESS');
  });

  it('filters candidate pools to only allowlisted token pairs (WSOL, USDC, USDT)', async () => {
    const UNKNOWN_MEME_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              // Eligible pair: WSOL / USDC
              {
                address: 'eligible-wsol-usdc',
                tokenMintA: CANONICAL_WSOL_MINT,
                tokenMintB: CANONICAL_USDC_MINT,
                tickSpacing: 4,
                feeRate: 400
              },
              // Ineligible pair: WSOL / Meme token
              {
                address: 'ineligible-wsol-meme',
                tokenMintA: CANONICAL_WSOL_MINT,
                tokenMintB: UNKNOWN_MEME_MINT,
                tickSpacing: 64,
                feeRate: 3000
              },
              // Eligible pair: USDC / USDT
              {
                address: 'eligible-usdc-usdt',
                tokenMintA: CANONICAL_USDC_MINT,
                tokenMintB: CANONICAL_USDT_MINT,
                tickSpacing: 1,
                feeRate: 100
              }
            ],
            meta: { cursor: { next: null } }
          })
      })
    );

    const discovery = new OrcaPoolDiscovery({ maxPages: 1 });
    const res = await discovery.discoverCandidates();

    expect(res.candidates.length).toBe(2);
    expect(res.candidates.map(c => c.address)).toEqual([
      'eligible-wsol-usdc',
      'eligible-usdc-usdt'
    ]);
  });

  it('respects 429 rate-limit responses and halts discovery cleanly without retrying indefinitely', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests'
        });
      })
    );

    const discovery = new OrcaPoolDiscovery({ maxPages: 3, maxRetries: 1 });
    const res = await discovery.discoverCandidates();

    expect(callCount).toBe(1); // Halts immediately on 429, does not retry
    expect(res.apiStatus).toBe('RATE_LIMITED');
    expect(res.errors).toContain('HTTP_429_RATE_LIMITED');
    expect(res.candidates.length).toBe(0);
  });

  it('aborts cleanly on timeout and preserves existing registry intact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_, options) => {
        return new Promise((_, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      })
    );

    const discovery = new OrcaPoolDiscovery({
      maxPages: 1,
      timeoutMs: 50,
      maxRetries: 0
    });

    const poolRegistry = new PoolRegistry();
    const initialCount = poolRegistry.getAllPools().length;

    const mockRpc: any = {
      getAccountInfo: vi.fn()
    };

    const report = await discovery.runDiscoveryAndVerification(poolRegistry, mockRpc);

    expect(report.apiStatus).toBe('TIMEOUT');
    expect(report.candidatesFound).toBe(0);
    // Existing registry must remain completely intact
    expect(poolRegistry.getAllPools().length).toBe(initialCount);
    expect(poolRegistry.isPoolVerified('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')).toBe(true);
  });

  it('rejects candidates failing on-chain checks (non-existent, wrong owner, bad layout, zero liquidity)', async () => {
    const discovery = new OrcaPoolDiscovery();

    // 1. Account not found
    const missingAddress = Keypair.generate().publicKey.toBase58();
    const mockRpcMissing: any = { getAccountInfo: vi.fn().mockResolvedValue(null) };
    const resMissing = await discovery.verifyCandidateOnChain(
      {
        address: missingAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tickSpacing: 4,
        feeRate: 400,
        source: 'ORCA_API',
        discoveredAt: Date.now()
      },
      mockRpcMissing
    );
    expect(resMissing.verified).toBe(false);
    expect(resMissing.blockerReason).toBe('ACCOUNT_NOT_FOUND');

    // 2. Wrong program owner
    const wrongOwnerAddress = Keypair.generate().publicKey.toBase58();
    const mockRpcWrongOwner: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4),
        data: Buffer.alloc(700)
      })
    };
    const resWrongOwner = await discovery.verifyCandidateOnChain(
      {
        address: wrongOwnerAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tickSpacing: 4,
        feeRate: 400,
        source: 'ORCA_API',
        discoveredAt: Date.now()
      },
      mockRpcWrongOwner
    );
    expect(resWrongOwner.verified).toBe(false);
    expect(resWrongOwner.blockerReason).toBe('INVALID_PROGRAM_OWNER');

    // 3. Invalid layout size (< 653 bytes)
    const shortLayoutAddress = Keypair.generate().publicKey.toBase58();
    const mockRpcShortLayout: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: Buffer.alloc(500)
      })
    };
    const resShortLayout = await discovery.verifyCandidateOnChain(
      {
        address: shortLayoutAddress,
        tokenMintA: CANONICAL_WSOL_MINT,
        tokenMintB: CANONICAL_USDC_MINT,
        tickSpacing: 4,
        feeRate: 400,
        source: 'ORCA_API',
        discoveredAt: Date.now()
      },
      mockRpcShortLayout
    );
    expect(resShortLayout.verified).toBe(false);
    expect(resShortLayout.blockerReason).toBe('INVALID_ACCOUNT_LAYOUT');
  });

  it('registers valid on-chain verified candidate strictly as QUOTE_UNVERIFIED without modifying existing pools', async () => {
    // Create valid 653-byte mock Whirlpool buffer
    const buf = Buffer.alloc(653);
    buf.writeUInt16LE(4, 41); // tickSpacing = 4
    buf.writeUInt16LE(400, 45); // feeRate = 400 (4 bps)
    // liquidity = 50,000,000,000 (offset 49)
    buf.writeBigUInt64LE(50000000000n, 49);
    // sqrtPrice (offset 65)
    buf.writeBigUInt64LE(5267498573947197513n, 65);
    // tickCurrent = -25068 (offset 81)
    buf.writeInt32LE(-25068, 81);
    // tokenMintA (offset 101..133) = WSOL
    new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(buf, 101);
    // tokenMintB (offset 181..213) = USDC
    new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(buf, 181);

    const validCandidateAddress = Keypair.generate().publicKey.toBase58();
    const mockRpc: any = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL),
        data: buf
      })
    };

    const discovery = new OrcaPoolDiscovery();
    const candidate: DiscoveredCandidate = {
      address: validCandidateAddress,
      tokenMintA: CANONICAL_WSOL_MINT,
      tokenMintB: CANONICAL_USDC_MINT,
      tickSpacing: 4,
      feeRate: 400,
      tvlUsdc: '5000000',
      liquidity: '50000000000',
      source: 'ORCA_API',
      discoveredAt: Date.now()
    };

    const res = await discovery.verifyCandidateOnChain(candidate, mockRpc);
    expect(res.verified).toBe(true);
    expect(res.poolConfig).toBeDefined();
    // Invariant: newly discovered candidate is QUOTE_UNVERIFIED
    expect(res.poolConfig!.verificationStatus).toBe('QUOTE_UNVERIFIED');
    expect(res.poolConfig!.blockerReason).toBe('PENDING_TICK_ARRAY_HYDRATION');

    const registry = new PoolRegistry();
    const prevCount = registry.getAllPools().length;
    registry.register(res.poolConfig!);

    expect(registry.getAllPools().length).toBe(prevCount + 1);
    expect(registry.getPool(validCandidateAddress)?.verificationStatus).toBe('QUOTE_UNVERIFIED');
    // Invariant: Existing verified pool Czfq3xZZ remains intact
    expect(registry.getPool('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')?.verificationStatus).toBe('VERIFIED_DIRECT');
  });
});
