/**
 * Core Types and Enums for Solana Arbitrage Scanner (Phase 1.2: Competition-Aware Opportunity Engine)
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
  | 'PANCAKESWAP'
  | 'MANIFEST'
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
  | 'JUPITER_ORDER_INDICATIVE'
  | 'UNVERIFIED';

export type ExecutionTag =
  | 'POTENTIAL_ATOMIC'            // Plausible future single-tx atomic execution route
  | 'INDICATIVE_ONLY';            // Off-chain RFQ / non-atomic / indicative only

export type CycleType = '2_LEG' | '3_LEG';

export type OpportunityQualityLabel =
  | 'INVALID'                     // Stale data, unknown fees, unsafe token, invalid pools or missing quote support
  | 'INDICATIVE_ONLY'             // Price difference exists but atomic composition or executable quote is unverified
  | 'SHADOW_QUALIFIED';           // All read-only math, route, pool and cost checks pass >= $0.50 conservative estimated profit

export type SurvivalStatus = 'SURVIVED' | 'DECAYED' | 'UNCHECKED';

export type TradeSizingMethod = 'COARSE_GRID' | 'COARSE_TO_FINE';

export type ExecutionProbability = 'UNCALIBRATED';

export type ContentionLevel = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface FeeDistribution {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface CompetitorActivityMetrics {
  poolId: string;
  totalObservedTx: number;
  successfulTxCount: number;
  failedTxCount: number;
  failureRate: number;
  feeDistributionLamports: FeeDistribution;
  priorityFeeStatsMicroLamports: FeeDistribution;
  jitoTipCount: number;
  jitoTipDistributionLamports: { min: number; p50: number; p95: number; max: number };
  contentionLevel: ContentionLevel;
  historicalCompetitionScore: number; // 0 to 100
  arbitrageLoopFrequencyPerHour: number;
  sampleWindowSeconds: number;
  lastAnalyzedSlot: number;
  timestamp: number;
}

export interface ScoringBreakdown {
  profitabilityScore: number;     // 0 to 35 pts based on conservative net profit
  capitalEfficiencyScore: number; // 0 to 20 pts based on net profit / trade size
  quoteFreshnessScore: number;    // 0 to 15 pts based on quote age & slot lag
  competitionPenalty: number;     // 0 to 20 pts deducted for high pool contention
  complexityScore: number;        // 0 to 10 pts based on route leg count & cross-DEX overhead
  totalScore: number;             // 0 to 100 overall competition score
  rationale: string[];
}

export type OpportunityStatus =
  | 'OBSERVED'                    // Pool state updated, not a completed quote
  | 'PRICED'                      // Legs quoted, freshness & synchronization verified
  | 'CANDIDATE'                   // Full cost estimate available, expected net positive
  | 'QUALIFIED_SHADOW'            // Conservative net >= $0.50 after all fees and buffer
  | 'REJECTED'                    // Violated profitability, risk, or validation rules
  | 'UNSUPPORTED'                 // Lacks verified adapter or route compatibility
  | 'STALE'                       // Slot gap or quote age exceeded configured threshold
  | 'DEGRADED';                   // Feed disconnected or unreliable

export interface SizeAlternative {
  sizeUSDC: number;
  expectedNetUSDC: string;
  conservativeNetUSDC: string;
  isViable: boolean;
  rejectionReason?: string;
}

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
  | 'TICK_BOUNDARY_EXCEEDED'
  | 'SPREAD_PREFILTER_REJECTED'
  | 'SIMULATED_CAPITAL_EXHAUSTED'
  | 'OBSERVATION_EXPIRED'
  | 'ACCOUNT_POINTERS_CHANGED'
  | 'OPENORDERS_LAYOUT_INVALID'
  | 'OPENORDERS_MARKET_MISMATCH'
  | 'OPENORDERS_AUTHORITY_MISMATCH'
  | 'OPENORDERS_OWNER_MISMATCH'
  | 'SUBSCRIPTION_LOSS'
  | 'QUOTE_UNVERIFIED'
  | 'UNSUPPORTED_ROUTE'
  | 'REUSED_IDENTICAL_POOL'
  | 'MISSING_COST_ESTIMATE'
  | 'LOW_CONSERVATIVE_NET'
  | 'PRICE_CONVERSION_STALE'
  | 'DUPLICATE_SIGNAL'
  | 'TOO_MANY_ACCOUNTS_UNKNOWN'
  | 'COMPUTE_LIMIT_EXCEEDED'
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
  isUnverified?: boolean;
  unverifiedReason?: string;
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
  recoverableDepositUSDC?: string;    // Rent deposit returned upon ATA closing
  consumedCostUSDC?: string;          // Permanently consumed costs (signatures + compute + tip)
  potentialLossOnFailureUSDC?: string;// Maximum loss if tx reverts on-chain (signatures + compute)
  riskRewardRatio?: string;           // Potential loss on failure divided by conservative net profit
  assumptions: string[];              // Auditable list of cost assumptions
}

export interface ArbitrageCandidate {
  candidateId: string;
  routeName: string;
  direction: string;
  cycleType?: CycleType;
  qualityLabel?: OpportunityQualityLabel;
  optimalSizeUSDC?: number;
  sizingMethod?: TradeSizingMethod;
  inputAmountUSDC: bigint;            // Exact input USDC (6 decimals)
  
  // Leg 1
  leg1Quote: SwapQuote;
  leg1ExpectedOutWSOL: bigint;        // Expected intermediate token output from leg 1
  leg1ConservativeOutWSOL: bigint;    // Conservative intermediate token input to leg 2 (after slippage allowance)

  // Leg 2
  leg2Quote: SwapQuote;
  leg2ExpectedOutUSDC: bigint;        // Expected output from leg 2
  leg2ConservativeOutUSDC: bigint;    // Conservative output from leg 2

  // Optional Leg 3 (for 3-leg triangular arbitrage cycles)
  leg3Quote?: SwapQuote;
  leg3ExpectedOutUSDC?: bigint;
  leg3ConservativeOutUSDC?: bigint;

  costs: CostBreakdown;
  recoverableDepositUSDC?: string;
  consumedCostUSDC?: string;
  potentialLossOnFailureUSDC?: string;
  expectedNetUSDC: string;            // legEndExpectedOut - initialUSDC - costs (Decimal string)
  minConservativeNetUSDC: string;     // legEndConservativeOut - initialUSDC - costs - buffer (Decimal string)
  status: OpportunityStatus;
  rejectionReasons: RejectionReasonCode[];
  timestamp: number;
  slotGap: number;
  quoteAgeMs: number;
  survivalStatus?: SurvivalStatus;

  // Phase 1.2 Competition-Aware Intelligence Additions
  competitionScore?: number;          // 0 to 100 deterministic competition & quality score
  executionProbability?: ExecutionProbability; // Strictly 'UNCALIBRATED' prior to live execution
  visibilityDurationMs?: number;      // Continuous observation duration across snapshots
  observedSnapshotsCount?: number;    // Number of sequential snapshots where opportunity was visible
  scoringBreakdown?: ScoringBreakdown;// Itemized deterministic score explanation

  // Profit-First Algorithm Additions
  topAlternatives?: SizeAlternative[]; // Evaluated alternative sizes and their net profit
  stateVersion?: string;               // Snapshot version signature (pool slots)
  executionStatus?: 'EXECUTION_UNVERIFIED' | 'SIMULATION_PASSED' | 'ATOMIC_READY';
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

export interface AuditMetrics {
  totalEvaluated: number;
  uniqueOpportunities: number;
  candidatesGrossPositive: number;
  candidatesConservativeQualified: number;
  rejectedRoutes: number;
  quoteValidationFailures: number;
  unsupportedRoutes: number;
  staleDataRejections: number;
  twoLegEvaluated?: number;
  threeLegEvaluated?: number;
  intraDexEvaluated?: number;
  interDexEvaluated?: number;
  shadowQualifiedCount?: number;
  survivalCheckedCount?: number;
  survivalSurvivedCount?: number;
  survivalDecayedCount?: number;

  // Profit-First Stage Funnel Counts
  configuredRouteCount?: number;
  stateReadyRouteCount?: number;
  quoteValidRouteCount?: number;
  profitQualifiedRouteCount?: number;
  executionUnverifiedRouteCount?: number;

  // Competition intelligence metrics
  competitorTxsAnalyzed?: number;
  averageCompetitionScore?: number;
  maxOpportunityVisibilityMs?: number;
  meanOpportunityVisibilityMs?: number;
  // Diagnostic Rejection Counts (Orca & Raydium State Integrity)
  orcaTickBoundaryAttempts?: number;
  orcaOtherFailureAttempts?: number;
  raydiumReconfirmationAttempts?: number;
  raydiumReconfirmationSuccesses?: number;
}
