import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { ArbitrageCandidate, SwapQuote } from '../types/index.js';

/**
 * PHASE 1.1 FUTURE EXECUTION READINESS INTERFACES
 * 
 * Strictly Architectural Interfaces & Types Only.
 * NO live execution, NO private keys, NO transaction broadcasting.
 */

export interface TransactionTemplate {
  templateId: string;
  routeName: string;
  instructions: TransactionInstruction[];
  lookupTables?: PublicKey[];
  estimatedComputeUnits: number;
  priorityFeeLamports: number;
  jitoTipLamports: number;
  minimumOutputAmount: bigint;
  createdAtSlot: number;
  expiresAtSlot: number;
}

export interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAtSlot: number;
  receivedAtMs: number;
  isValid: boolean;
}

export interface BlockhashCache {
  getLatestBlockhash(): CachedBlockhash | null;
  refresh(): Promise<CachedBlockhash>;
  isStale(currentSlot: number, maxSlotAge?: number): boolean;
}

export interface CachedLookupTable {
  key: PublicKey;
  addresses: PublicKey[];
  lastUpdatedSlot: number;
}

export interface AltCache {
  getLookupTable(key: PublicKey): CachedLookupTable | null;
  setLookupTable(key: PublicKey, addresses: PublicKey[], slot: number): void;
  prefetchTables(keys: PublicKey[]): Promise<void>;
}

export interface MinimumProfitConstraint {
  minOutputAmountUSDC: bigint;
  expectedNetUSDC: string;
  minConservativeNetUSDC: string;
  slippageToleranceBps: number;
  enforceOnChainProtection: boolean;
}

export interface AtomicRouteComposer {
  composeSwapInstructions(
    candidate: ArbitrageCandidate,
    leg1Quote: SwapQuote,
    leg2Quote: SwapQuote,
    constraints: MinimumProfitConstraint
  ): Promise<TransactionInstruction[]>;
}

export interface PriorityFeeEstimator {
  estimatePriorityFee(requestedComputeUnits: number, targetPercentile?: number): Promise<number>;
  getRecentMedianFee(): number;
}

export interface JitoTipPolicy {
  minimumTipLamports: number;
  targetPercentileTipLamports: number;
  maxTipLamports: number;
  tipAccount: PublicKey;
  calculateTip(expectedNetProfitUSDC: number, solPriceUSDC: number): number;
}

export interface BundleSubmissionInterface {
  simulateBundle?(instructions: TransactionInstruction[]): Promise<{ success: boolean; logs: string[] }>;
  prepareBundlePayload?(instructions: TransactionInstruction[], tipLamports: number): Promise<Uint8Array>;
}

export interface AlternativeRpcSender {
  endpointUrl: string;
  name: string;
  isFallback: boolean;
  health: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
}

/**
 * PROFIT-FIRST FUTURE EXECUTION CONTRACT SPECIFICATION
 * 
 * Strict specifications for eventual atomic multi-hop transaction composition.
 * No signing, no transaction broadcast, and no keypairs in Phase 1.1 / Phase 1.2.
 */

export interface ExecutionInstructionLayout {
  stepIndex: number;
  type:
    | 'COMPUTE_BUDGET_LIMIT'
    | 'COMPUTE_BUDGET_PRICE'
    | 'JITO_TIP'
    | 'SWAP_LEG_1'
    | 'SWAP_LEG_2'
    | 'SWAP_LEG_3'
    | 'ON_CHAIN_PROFIT_GUARD';
  programId: PublicKey;
  description: string;
  isAtomicGuard: boolean;
}

export interface ExecutionContractSpec {
  routeId: string;
  cycleType: '2_LEG' | '3_LEG';
  initialAmountUSDC: bigint;
  minimumOutputAmountUSDC: bigint;
  minNetProfitUSDC: string;
  instructionLayout: ExecutionInstructionLayout[];
  maxComputeUnits: number;
  targetPriorityFeeMicroLamports: number;
  jitoTipLamports: number;
  requiresLookupTable: boolean;
  lookupTableAddresses?: PublicKey[];
  /** Status remains EXECUTION_UNVERIFIED until composition and simulation demonstrate feasibility */
  executionStatus: 'EXECUTION_UNVERIFIED' | 'SIMULATION_PASSED' | 'ATOMIC_READY';
}

export interface PreflightSimulationRequirements {
  simulatedComputeUnits: number;
  computeUnitMarginBps: number;
  writableAccountContention: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  duplicateInflightPreventionKey: string;
  cooldownPeriodMs: number;
  failedAttemptCostLamports: number;
  simulationSuccess: boolean;
  simulationLogs: string[];
}

export interface OperatorRiskBudget {
  maxDailyLossUSDC: number;
  currentDailyConsumedLossUSDC: number;
  maxConsecutiveFailures: number;
  currentConsecutiveFailures: number;
  circuitBreakerTripped: boolean;
  virtualCapitalLimitUSDC: number;
  activeAllocatedCapitalUSDC: number;
}
