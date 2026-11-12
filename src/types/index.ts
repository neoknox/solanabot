/**
 * Core Types and Enums for Solana Arbitrage Scanner (Phase 1)
 * Strictly READ-ONLY. No wallet, no signer, no transaction broadcast interfaces.
 */

export type DexType =
  | 'RAYDIUM_AMM'
  | 'RAYDIUM_CPMM'
  | 'RAYDIUM_CLMM'
  | 'ORCA_WHIRLPOOL'
  | 'METEORA_DLMM'
  | 'METEORA_DAMM'
  | 'PHOENIX'
  | 'OPENBOOK_V2'
  | 'PUMP_FUN'
  | 'ZERO_FI'
  | 'HUMIDI_FI'
  | 'SOL_FI'
  | 'GOON_FI'
  | 'BISON_FI'
  | 'UNKNOWN';

export type DexSupportStatus =
  | 'DIRECT_SUPPORTED'           // Fully supported via direct on-chain state decoding + math
  | 'JUPITER_BUILD_METIS'         // Supported via Jupiter Metis /build composable route
  | 'JUPITER_ORDER_INDICATIVE'    // Discovered via Jupiter /order RFQ indicative route (non-composable)
  | 'PROPRIETARY_RESTRICTED'      // Discovered proprietary RFQ (ZeroFi, SolFi, etc.) - visibility only
  | 'UNSUPPORTED';                // Lacks verified pool, math, or accessible state

export type RouteCategory =
  | 'DIRECT_POOL'
  | 'JUPITER_BUILD_METIS'
  | 'JUPITER_ORDER_INDICATIVE';

export type ExecutionTag =
  | 'POTENTIAL_ATOMIC'            // Plausible future single-tx atomic execution route
  | 'INDICATIVE_ONLY';            // Off-chain RFQ / non-atomic / indicative only

export type OpportunityStatus =
  | 'OBSERVED'                    // Pool state updated, not a completed quote
  | 'PRICED'                      // Both legs quoted, freshness & synchronization verified
  | 'CANDIDATE'                   // Full cost estimate available, expected net positive
  | 'QUALIFIED_SHADOW'            // Conservative net >= $0.50 after all fees and buffer
  | 'REJECTED'                    // Violated profitability, risk, or validation rules
  | 'UNSUPPORTED'                 // Lacks verified adapter or route compatibility
  | 'STALE'                       // Slot gap or quote age exceeded configured threshold
  | 'DEGRADED';                   // Feed disconnected or unreliable

export type RejectionReasonCode =
  | 'STALE_QUOTE'
  | 'SLOT_MISMATCH'
  | 'WS_DISCONNECTED'
  | 'RPC_ERROR'
  | 'RATE_LIMITED'
  | 'INVALID_MINT'
  | 'TOKEN_RESTRICTION'
  | 'INVALID_DECIMALS'
  | 'INVALID_PROGRAM_ID'
  | 'UNKNOWN_POOL'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'EXCESSIVE_PRICE_IMPACT'
  | 'MISSING_TICK_DATA'
  | 'UNSUPPORTED_ROUTE'
  | 'REUSED_IDENTICAL_POOL'
  | 'MISSING_COST_ESTIMATE'
  | 'LOW_CONSERVATIVE_NET'
  | 'PRICE_CONVERSION_STALE'
  | 'DUPLICATE_SIGNAL'
  | 'TOO_MANY_ACCOUNTS_UNKNOWN'
  | 'PROVIDER_UNAVAILABLE';

export type FeedHealth = 'HEALTHY' | 'DEGRADED' | 'STALE' | 'DISCONNECTED';

export interface TokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
  name: string;
  programId: string;
  transferFeeBps?: number;
  isRestricted?: boolean;
}

export interface PoolState {
  id: string;                         // Pool account address
  dex: DexType;
  programId: string;                  // DEX on-chain program ID
  tokenAMint: string;
  tokenBMint: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  reserveA?: bigint;                  // In base token integer units
  reserveB?: bigint;                  // In quote token integer units
  feeBps: number;                     // Base fee in basis points (1 bps = 0.01%)
  slot: number;                       // Slot at which state was read
  receivedAt: number;                 // Local millisecond timestamp
  liquidityUsd: number;               // Estimated TVL in USD
  feedHealth: FeedHealth;
  extraData?: Record<string, unknown>; // DEX-specific (tickSpacing, sqrtPrice, activeBinId, etc.)
}

export interface SwapQuote {
  quoteSource: RouteCategory;
  poolId: string;
  dex: DexType;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;                   // Exact integer base units
  outAmount: bigint;                  // Exact integer base units (after pool fee & impact)
  feeIncluded: boolean;               // True if outAmount already accounts for pool fee
  feeAmount: bigint;                  // Estimated DEX pool fee deducted
  priceImpactBps: number;             // Price impact in basis points
  slot: number;                       // Block slot when quote was produced/observed
  timestamp: number;                  // Local unix timestamp in milliseconds
  executionType: ExecutionTag;
  rawRouteInfo?: unknown;
}

export interface CostBreakdown {
  networkFeeUSDC: string;             // Base signature fee converted to USDC
  priorityFeeUSDC: string;            // Micro-lamport compute budget fee converted to USDC
  jitoTipUSDC: string;                // Validator tip estimate converted to USDC
  tokenTransferFeesUSDC: string;      // Token-2022 transfer fee if applicable
  contingencyUSDC: string;            // Worst-case execution contingency
  safetyBufferUSDC: string;           // Required safety buffer hurdle
  totalCostsUSDC: string;             // Sum of all variable and fixed costs
  solPriceUSDC: string;               // SOL/USDC price used for lamport conversions
  assumptions: string[];              // Auditable list of cost assumptions
}

export interface ArbitrageCandidate {
  candidateId: string;
  routeName: string;
  leg1Quote: SwapQuote;
  leg2Quote: SwapQuote;
  direction: 'USDC_TO_WSOL_TO_USDC';
  inputAmountUSDC: bigint;            // Exact input USDC (6 decimals)
  leg1ExpectedOutWSOL: bigint;        // Expected WSOL output from leg 1
  leg1ConservativeOutWSOL: bigint;    // Conservative WSOL input to leg 2 (after slippage allowance)
  leg2ExpectedOutUSDC: bigint;        // Expected USDC output from leg 2
  leg2ConservativeOutUSDC: bigint;    // Conservative USDC output (after slippage allowance)
  costs: CostBreakdown;
  expectedNetUSDC: string;            // leg2ExpectedOut - initialUSDC - costs (Decimal string)
  minConservativeNetUSDC: string;     // leg2ConservativeOut - initialUSDC - costs - buffer (Decimal string)
  status: OpportunityStatus;
  rejectionReasons: RejectionReasonCode[];
  timestamp: number;
  slotGap: number;
  quoteAgeMs: number;
}

export interface ScanHealthStatus {
  connectedRpc: boolean;
  connectedWs: boolean;
  jupiterStatus: 'OK' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'DISABLED';
  currentSlot: number;
  lastSlotUpdateTime: number;
  quotesPerSecond: number;
  qualifiedCount: number;
  rejectedCount: number;
  rejectionBreakdown: Record<string, number>;
  activePoolCount: number;
  poolsPerDex: Record<string, number>;
}
