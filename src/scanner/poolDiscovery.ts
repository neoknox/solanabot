import { PublicKey } from '@solana/web3.js';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS,
  ALLOWLISTED_MINTS,
  AppConfig
} from '../config/index.js';
import { PoolRegistry, PoolConfig } from './poolRegistry.js';
import { SolanaRpcProvider } from '../providers/solanaRpc.js';
import { OrcaWhirlpoolAdapter } from '../dex/orcaWhirlpoolAdapter.js';

export interface DiscoveredCandidate {
  address: string;
  tokenMintA: string;
  tokenMintB: string;
  tickSpacing: number;
  feeRate: number;
  tvlUsdc?: string;
  liquidity?: string;
  source: 'ORCA_API';
  discoveredAt: number;
}

export interface VerificationResult {
  address: string;
  verified: boolean;
  blockerReason?: string;
  poolConfig?: PoolConfig;
  onChainOwner?: string;
  dataLength?: number;
  activeLiquidity?: string;
  tickCurrent?: number;
}

export interface DiscoveryReport {
  apiStatus: 'SUCCESS' | 'RATE_LIMITED' | 'FAILED' | 'TIMEOUT';
  pagesFetched: number;
  candidatesFound: number;
  candidatesVerified: number;
  candidatesRejected: number;
  results: VerificationResult[];
  errors: string[];
  durationMs: number;
}

export interface OrcaDiscoveryOptions {
  apiBaseUrl?: string;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OrcaPoolDiscovery {
  private apiBaseUrl: string;
  private pageSize: number;
  private maxPages: number;
  private timeoutMs: number;
  private maxRetries: number;
  private adapter: OrcaWhirlpoolAdapter;

  constructor(options: OrcaDiscoveryOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl || 'https://api.orca.so/v2/solana/pools';
    this.pageSize = Math.min(options.pageSize || 10, 10); // Maximum 10 results per page
    this.maxPages = Math.min(options.maxPages || 3, 3);   // Maximum 3 pages per run
    this.timeoutMs = options.timeoutMs || 10000;          // 10 seconds timeout
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 1; // Maximum 1 retry
    this.adapter = new OrcaWhirlpoolAdapter();
  }

  /**
   * Fetches candidate pools from Orca's official public API using bounded pagination,
   * strict 10s AbortSignal timeout, 429 rate-limit handling, and allowlisted mint filtering.
   */
  public async discoverCandidates(): Promise<{
    candidates: DiscoveredCandidate[];
    pagesFetched: number;
    apiStatus: 'SUCCESS' | 'RATE_LIMITED' | 'FAILED' | 'TIMEOUT';
    errors: string[];
  }> {
    const candidates: DiscoveredCandidate[] = [];
    const seenAddresses = new Set<string>();
    const errors: string[] = [];
    let cursor: string | null = null;
    let pagesFetched = 0;
    let apiStatus: 'SUCCESS' | 'RATE_LIMITED' | 'FAILED' | 'TIMEOUT' = 'SUCCESS';

    for (let page = 1; page <= this.maxPages; page++) {
      let pageSuccess = false;
      let retriesLeft = this.maxRetries;

      while (!pageSuccess && retriesLeft >= 0) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          let url = `${this.apiBaseUrl}?limit=${this.pageSize}`;
          if (cursor) {
            url += `&cursor=${encodeURIComponent(cursor)}`;
          }

          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'SolanaArbitrageBot-Phase1.3/Discovery'
            }
          });

          if (response.status === 429) {
            console.warn('[ORCA_DISCOVERY] Received 429 Rate Limited response from Orca API. Halting discovery cleanly.');
            apiStatus = 'RATE_LIMITED';
            errors.push('HTTP_429_RATE_LIMITED');
            return { candidates, pagesFetched, apiStatus, errors };
          }

          if (!response.ok) {
            throw new Error(`HTTP_${response.status}_${response.statusText}`);
          }

          const json: any = await response.json();
          pagesFetched++;
          pageSuccess = true;

          const rawPools: any[] = Array.isArray(json) ? json : (json.data || []);
          for (const raw of rawPools) {
            const address = raw.address;
            if (!address || seenAddresses.has(address)) continue;

            const mintA = raw.tokenMintA || raw.tokenA?.address;
            const mintB = raw.tokenMintB || raw.tokenB?.address;

            // Strict Filter: Token mints must be in canonical allowlist (WSOL, USDC, USDT)
            if (mintA && mintB && ALLOWLISTED_MINTS.has(mintA) && ALLOWLISTED_MINTS.has(mintB)) {
              seenAddresses.add(address);
              candidates.push({
                address,
                tokenMintA: mintA,
                tokenMintB: mintB,
                tickSpacing: raw.tickSpacing || 0,
                feeRate: raw.feeRate || 0,
                tvlUsdc: raw.tvlUsdc?.toString(),
                liquidity: raw.liquidity?.toString(),
                source: 'ORCA_API',
                discoveredAt: Date.now()
              });
            }
          }

          cursor = json.meta?.cursor?.next || null;
          if (!cursor) {
            // No further pages available
            break;
          }
        } catch (err: any) {
          retriesLeft--;
          if (err.name === 'AbortError') {
            console.warn(`[ORCA_DISCOVERY] Page ${page} request timed out after ${this.timeoutMs}ms.`);
            if (retriesLeft < 0) {
              apiStatus = 'TIMEOUT';
              errors.push(`PAGE_${page}_TIMEOUT_${this.timeoutMs}MS`);
            }
          } else {
            console.warn(`[ORCA_DISCOVERY] Page ${page} request failed: ${err.message}`);
            if (retriesLeft < 0) {
              apiStatus = 'FAILED';
              errors.push(`PAGE_${page}_FAILED: ${err.message}`);
            }
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // If page completely failed after retries, abort remaining pagination cleanly
      if (!pageSuccess) {
        break;
      }
    }

    return { candidates, pagesFetched, apiStatus, errors };
  }

  /**
   * Verifies a candidate pool on-chain using targeted Solana RPC getAccountInfo only.
   * Enforces program owner, 653+ byte layout, mint match, positive fee/spacing, and active liquidity.
   * Unverified pools remain QUOTE_UNVERIFIED.
   */
  public async verifyCandidateOnChain(
    candidate: DiscoveredCandidate,
    rpcProvider: SolanaRpcProvider
  ): Promise<VerificationResult> {
    try {
      const pubkey = new PublicKey(candidate.address);
      const accountInfo = await rpcProvider.getAccountInfo(pubkey);

      if (!accountInfo) {
        return {
          address: candidate.address,
          verified: false,
          blockerReason: 'ACCOUNT_NOT_FOUND'
        };
      }

      const onChainOwner = accountInfo.owner.toBase58();
      const dataLength = accountInfo.data.length;

      // 1. Program Owner Validation
      if (onChainOwner !== KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL) {
        return {
          address: candidate.address,
          verified: false,
          onChainOwner,
          dataLength,
          blockerReason: 'INVALID_PROGRAM_OWNER'
        };
      }

      // 2. Minimum Whirlpool layout size (653 bytes)
      if (dataLength < 653) {
        return {
          address: candidate.address,
          verified: false,
          onChainOwner,
          dataLength,
          blockerReason: 'INVALID_ACCOUNT_LAYOUT'
        };
      }

      // 3. Decode Whirlpool pool state
      const decoded = this.adapter.decodePoolState(accountInfo.data, candidate.address, 0);
      if (!decoded) {
        return {
          address: candidate.address,
          verified: false,
          onChainOwner,
          dataLength,
          blockerReason: 'FAILED_TO_DECODE_WHIRLPOOL_STATE'
        };
      }

      // 4. Exact Token Mint Validation (must be in allowlist and match candidate)
      if (
        !ALLOWLISTED_MINTS.has(decoded.tokenAMint) ||
        !ALLOWLISTED_MINTS.has(decoded.tokenBMint) ||
        decoded.tokenAMint === decoded.tokenBMint
      ) {
        return {
          address: candidate.address,
          verified: false,
          onChainOwner,
          dataLength,
          blockerReason: 'UNSUPPORTED_TOKEN_MINTS'
        };
      }

      // 5. Valid Tick Spacing & Fee Rate
      const extra = decoded.extraData as any;
      const tickSpacing = extra?.tickSpacing || 0;
      const feeRate = extra?.feeRate || 0;
      if (tickSpacing <= 0 || feeRate <= 0) {
        return {
          address: candidate.address,
          verified: false,
          onChainOwner,
          dataLength,
          blockerReason: 'INVALID_TICK_SPACING_OR_FEE'
        };
      }

      // 6. Active Liquidity Validation (pool must have non-zero liquidity or positive TVL)
      const liquidity = BigInt(extra?.liquidity || '0');
      const tvlUsdc = parseFloat(candidate.tvlUsdc || '0');
      if (liquidity <= 0n && tvlUsdc <= 0) {
        return {
          address: candidate.address,
          verified: false,
          onChainOwner,
          dataLength,
          activeLiquidity: liquidity.toString(),
          blockerReason: 'ZERO_LIQUIDITY'
        };
      }

      // 7. Success: Pool qualifies as a valid on-chain Orca Whirlpool candidate.
      // NOTE: Strictly marked QUOTE_UNVERIFIED until required tick arrays are streamed and hydrated.
      const poolConfig: PoolConfig = {
        id: candidate.address,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: decoded.tokenAMint,
        tokenBMint: decoded.tokenBMint,
        feeBps: decoded.feeBps,
        initialLiquidityUsd: tvlUsdc > 0 ? tvlUsdc : undefined,
        description: `Orca Whirlpool (Discovered) ${decoded.feeBps} bps`,
        verificationStatus: 'QUOTE_UNVERIFIED',
        blockerReason: 'PENDING_TICK_ARRAY_HYDRATION'
      };

      return {
        address: candidate.address,
        verified: true,
        poolConfig,
        onChainOwner,
        dataLength,
        activeLiquidity: liquidity.toString(),
        tickCurrent: extra?.tickCurrent
      };
    } catch (err: any) {
      return {
        address: candidate.address,
        verified: false,
        blockerReason: `RPC_VERIFICATION_ERROR: ${err.message}`
      };
    }
  }

  /**
   * Executes the complete bounded discovery and on-chain verification workflow.
   * If discovery fails or throws, existing poolRegistry is left completely intact.
   */
  public async runDiscoveryAndVerification(
    poolRegistry: PoolRegistry,
    rpcProvider: SolanaRpcProvider
  ): Promise<DiscoveryReport> {
    const startTime = Date.now();
    const results: VerificationResult[] = [];
    const report: DiscoveryReport = {
      apiStatus: 'SUCCESS',
      pagesFetched: 0,
      candidatesFound: 0,
      candidatesVerified: 0,
      candidatesRejected: 0,
      results,
      errors: [],
      durationMs: 0
    };

    try {
      // 1. Discover candidates via Orca API
      const discovery = await this.discoverCandidates();
      report.apiStatus = discovery.apiStatus;
      report.pagesFetched = discovery.pagesFetched;
      report.candidatesFound = discovery.candidates.length;
      report.errors = discovery.errors;

      // 2. Perform targeted on-chain verification for each candidate
      for (const candidate of discovery.candidates) {
        // Skip pools already present in the registry
        if (poolRegistry.getPool(candidate.address)) {
          continue;
        }

        const verification = await this.verifyCandidateOnChain(candidate, rpcProvider);
        results.push(verification);

        if (verification.verified && verification.poolConfig) {
          report.candidatesVerified++;
          // Register as QUOTE_UNVERIFIED (Requirement 3 & 4)
          poolRegistry.register(verification.poolConfig);
        } else {
          report.candidatesRejected++;
        }
      }
    } catch (err: any) {
      report.apiStatus = 'FAILED';
      report.errors.push(`DISCOVERY_PIPELINE_ERROR: ${err.message}`);
    } finally {
      report.durationMs = Date.now() - startTime;
    }

    return report;
  }
}
