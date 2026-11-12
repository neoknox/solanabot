import { describe, it, expect } from 'vitest';
import { CompetitorAnalyzer, COMPUTE_BUDGET_PROGRAM_ID, CANONICAL_JITO_TIP_ACCOUNTS } from '../src/competition/analyzer.js';
import { CompetitionScorer } from '../src/profit/competitionScorer.js';
import { OpportunityTracker } from '../src/scanner/opportunityTracker.js';
import { ArbitrageCandidate, CompetitorActivityMetrics } from '../src/types/index.js';
import { CANONICAL_USDC_MINT, CANONICAL_WSOL_MINT } from '../src/config/index.js';

describe('Phase 1.2 Acceptance: Competition Engine & Opportunity Lifecycle', () => {
  describe('CompetitorAnalyzer: Transaction parsing and Contention Metrics', () => {
    const analyzer = new CompetitorAnalyzer();

    it('Matrix 1.2-I: Parses ComputeBudget priority fee, Jito tips, and circular arbitrage loops', () => {
      // 1. Construct opcode 3 SetComputeUnitPrice buffer (opcode: 3, micro-lamports: 50,000)
      const dataBuf = Buffer.alloc(9);
      dataBuf.writeUInt8(3, 0);
      dataBuf.writeBigUInt64LE(50000n, 1);
      const base64Data = dataBuf.toString('base64');

      const canonicalJitoAccount = Array.from(CANONICAL_JITO_TIP_ACCOUNTS)[0];

      const mockTx = {
        signature: 'tx-sig-1',
        slot: 250000100,
        err: null,
        fee: 10000,
        instructions: [
          {
            programId: COMPUTE_BUDGET_PROGRAM_ID,
            data: base64Data
          }
        ],
        accountKeys: [
          { pubkey: 'UserWallet11111111111111111111111111111111' },
          { pubkey: canonicalJitoAccount }
        ],
        preBalances: [1000000000, 5000000],
        postBalances: [989990000, 15000000], // +10,000,000 lamports (0.01 SOL) Jito tip
        preTokenBalances: [
          { accountIndex: 0, mint: CANONICAL_USDC_MINT, owner: 'UserWallet11111111111111111111111111111111', uiTokenAmount: { amount: '100000000' } },
          { accountIndex: 0, mint: CANONICAL_WSOL_MINT, owner: 'UserWallet11111111111111111111111111111111', uiTokenAmount: { amount: '0' } }
        ],
        postTokenBalances: [
          { accountIndex: 0, mint: CANONICAL_USDC_MINT, owner: 'UserWallet11111111111111111111111111111111', uiTokenAmount: { amount: '100500000' } },
          { accountIndex: 0, mint: CANONICAL_WSOL_MINT, owner: 'UserWallet11111111111111111111111111111111', uiTokenAmount: { amount: '0' } }
        ],
        blockTime: 1731420000
      };

      const parsed = analyzer.parseTransactionMetadata(mockTx);

      expect(parsed.signature).toBe('tx-sig-1');
      expect(parsed.slot).toBe(250000100);
      expect(parsed.priorityFeeMicroLamports).toBe(50000);
      expect(parsed.jitoTipLamports).toBe(10000000);
      expect(parsed.isArbitrageLoop).toBe(true);
      expect(parsed.feeLamports).toBe(10000);
      expect(parsed.err).toBeNull();
    });

    it('Matrix 1.2-J: Computes deterministic historical competition score and contention levels', () => {
      const poolId = 'test-pool-raydium-sol-usdc';
      const samples = [
        {
          signature: 'sig-1',
          slot: 100,
          err: null,
          feeLamports: 5000,
          priorityFeeMicroLamports: 20000,
          jitoTipLamports: 0,
          isArbitrageLoop: false,
          timestamp: 1000000
        },
        {
          signature: 'sig-2',
          slot: 101,
          err: { InstructionError: [0, 'Custom'] },
          feeLamports: 7500,
          priorityFeeMicroLamports: 100000,
          jitoTipLamports: 5000000,
          isArbitrageLoop: true,
          timestamp: 1005000
        },
        {
          signature: 'sig-3',
          slot: 102,
          err: null,
          feeLamports: 5000,
          priorityFeeMicroLamports: 50000,
          jitoTipLamports: 0,
          isArbitrageLoop: false,
          timestamp: 1010000
        }
      ];

      const metrics = analyzer.computeMetrics(poolId, samples);

      expect(metrics.poolId).toBe(poolId);
      expect(metrics.totalObservedTx).toBe(3);
      expect(metrics.successfulTxCount).toBe(2);
      expect(metrics.failedTxCount).toBe(1);
      expect(metrics.failureRate).toBeCloseTo(0.3333, 2);
      expect(metrics.feeDistributionLamports.min).toBe(5000);
      expect(metrics.feeDistributionLamports.max).toBe(7500);
      expect(metrics.priorityFeeStatsMicroLamports.p50).toBe(50000);
      expect(metrics.jitoTipCount).toBe(1);
      expect(metrics.contentionLevel).toBe('LOW'); // < 8 txs
      expect(metrics.historicalCompetitionScore).toBeGreaterThanOrEqual(0);
      expect(metrics.historicalCompetitionScore).toBeLessThanOrEqual(100);

      // Verify cached metrics access
      const cached = analyzer.getCachedMetrics(poolId);
      expect(cached.poolId).toBe(poolId);
      expect(cached.historicalCompetitionScore).toBe(metrics.historicalCompetitionScore);
    });
  });

  describe('CompetitionScorer: Multi-dimensional Opportunity Scoring', () => {
    const scorer = new CompetitionScorer();

    const createDummyCandidate = (overrides: Partial<ArbitrageCandidate> = {}): ArbitrageCandidate => ({
      candidateId: 'test-cand-1',
      routeName: 'Raydium AMM -> Orca Whirlpool',
      direction: 'USDC->WSOL->USDC',
      cycleType: '2_LEG',
      timestamp: Date.now(),
      status: 'QUALIFIED_SHADOW',
      qualityLabel: 'SHADOW_QUALIFIED',
      executionProbability: 'UNCALIBRATED',
      inputAmountUSDC: 100000000n,
      optimalSizeUSDC: 100,
      leg1ExpectedOutWSOL: 606000000n,
      leg1ConservativeOutWSOL: 605394000n,
      leg2ExpectedOutUSDC: 101000000n,
      leg2ConservativeOutUSDC: 100899000n,
      expectedNetUSDC: '0.7500',
      minConservativeNetUSDC: '0.6500',
      rejectionReasons: [],
      quoteAgeMs: 50,
      slotGap: 0,
      leg1Quote: {
        quoteSource: 'DIRECT_POOL',
        poolId: 'pool-1',
        dex: 'RAYDIUM_AMM',
        inputMint: CANONICAL_USDC_MINT,
        outputMint: CANONICAL_WSOL_MINT,
        inAmount: 100000000n,
        outAmount: 606000000n,
        feeIncluded: true,
        feeAmount: 250000n,
        priceImpactBps: 5,
        slot: 1000,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      },
      leg2Quote: {
        quoteSource: 'DIRECT_POOL',
        poolId: 'pool-2',
        dex: 'ORCA_WHIRLPOOL',
        inputMint: CANONICAL_WSOL_MINT,
        outputMint: CANONICAL_USDC_MINT,
        inAmount: 606000000n,
        outAmount: 101000000n,
        feeIncluded: true,
        feeAmount: 40000n,
        priceImpactBps: 3,
        slot: 1000,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC'
      },
      costs: {
        networkFeeUSDC: '0.000625',
        priorityFeeUSDC: '0.001250',
        jitoTipUSDC: '0.000000',
        tokenTransferFeesUSDC: '0.000000',
        contingencyUSDC: '0.0200',
        safetyBufferUSDC: '0.2500',
        totalCostsUSDC: '0.021875',
        solPriceUSDC: '165.00',
        assumptions: []
      },
      ...overrides
    });

    it('Matrix 1.2-K: Computes transparent score (0-100) and marks probability strictly UNCALIBRATED', () => {
      const candidate = createDummyCandidate({
        minConservativeNetUSDC: '0.7500',
        quoteAgeMs: 100,
        slotGap: 0
      });

      const poolMetrics: CompetitorActivityMetrics[] = [
        {
          poolId: 'pool-1',
          totalObservedTx: 10,
          successfulTxCount: 9,
          failedTxCount: 1,
          failureRate: 0.1,
          feeDistributionLamports: { min: 5000, p50: 5000, p95: 10000, max: 10000, mean: 5500 },
          priorityFeeStatsMicroLamports: { min: 0, p50: 10000, p95: 50000, max: 50000, mean: 15000 },
          jitoTipCount: 0,
          jitoTipDistributionLamports: { min: 0, p50: 0, p95: 0, max: 0 },
          contentionLevel: 'MEDIUM',
          historicalCompetitionScore: 25,
          arbitrageLoopFrequencyPerHour: 12,
          sampleWindowSeconds: 60,
          lastAnalyzedSlot: 1000,
          timestamp: Date.now()
        }
      ];

      const scored = scorer.scoreCandidate(candidate, poolMetrics);

      expect(scored.score).toBeGreaterThanOrEqual(0);
      expect(scored.score).toBeLessThanOrEqual(100);
      expect(scored.breakdown.profitabilityScore).toBeGreaterThan(0);
      expect(scored.breakdown.capitalEfficiencyScore).toBeGreaterThan(0);
      expect(scored.breakdown.quoteFreshnessScore).toBeGreaterThan(0);
      expect(scored.breakdown.competitionPenalty).toBeGreaterThan(0);
      expect(scored.breakdown.complexityScore).toBe(8); // Standard 2-leg cross-DEX

      // Non-negotiable requirement: Execution probability must remain strictly UNCALIBRATED
      expect(scored.executionProbability).toBe('UNCALIBRATED');

      // Verify human-readable rationale
      expect(scored.breakdown.rationale.length).toBe(5);
      expect(scored.breakdown.rationale[0]).toContain('Profitability:');
      expect(scored.breakdown.rationale[1]).toContain('Capital efficiency:');
      expect(scored.breakdown.rationale[2]).toContain('Quote freshness:');
      expect(scored.breakdown.rationale[3]).toContain('Competition:');
      expect(scored.breakdown.rationale[4]).toContain('Route complexity:');
    });

    it('Matrix 1.2-L: Intra-DEX routes receive higher complexity score than 3-leg triangular routes', () => {
      const intraCandidate = createDummyCandidate({
        routeName: 'Orca Whirlpool (4bps) -> Orca Whirlpool (2bps) (Intra-DEX)',
        cycleType: '2_LEG'
      });
      const triCandidate = createDummyCandidate({
        routeName: 'Orca -> Raydium -> Orca',
        cycleType: '3_LEG'
      });

      const intraScore = scorer.scoreCandidate(intraCandidate, []);
      const triScore = scorer.scoreCandidate(triCandidate, []);

      expect(intraScore.breakdown.complexityScore).toBe(10); // Intra-DEX bonus
      expect(triScore.breakdown.complexityScore).toBe(5);  // 3-leg triangular penalty
      expect(intraScore.breakdown.complexityScore).toBeGreaterThan(triScore.breakdown.complexityScore);
    });
  });

  describe('OpportunityTracker: Continuous Snapshot Visibility & Lifecycle Tracking', () => {
    it('Matrix 1.2-M: Tracks visibility duration and snapshot persistence across scans', () => {
      const tracker = new OpportunityTracker();

      const candidate: ArbitrageCandidate = {
        candidateId: 'opp-1',
        routeName: 'Raydium -> Orca',
        direction: 'USDC->WSOL->USDC',
        cycleType: '2_LEG',
        timestamp: 1000000,
        status: 'QUALIFIED_SHADOW',
        qualityLabel: 'SHADOW_QUALIFIED',
        executionProbability: 'UNCALIBRATED',
        inputAmountUSDC: 100000000n,
        optimalSizeUSDC: 100,
        leg1ExpectedOutWSOL: 606000000n,
        leg1ConservativeOutWSOL: 605394000n,
        leg2ExpectedOutUSDC: 101000000n,
        leg2ConservativeOutUSDC: 100899000n,
        expectedNetUSDC: '0.75',
        minConservativeNetUSDC: '0.65',
        rejectionReasons: [],
        quoteAgeMs: 20,
        slotGap: 0,
        leg1Quote: { poolId: 'pool-a', dex: 'RAYDIUM_AMM' } as any,
        leg2Quote: { poolId: 'pool-b', dex: 'ORCA_WHIRLPOOL' } as any,
        costs: {} as any
      };

      // Observation 1: Initial discovery
      const obs1 = tracker.trackOpportunity(candidate, 500);
      expect(obs1.visibilityDurationMs).toBe(0);
      expect(obs1.observedSnapshotsCount).toBe(1);

      // Observation 2: 400ms later on next slot
      candidate.timestamp = 1000400;
      const obs2 = tracker.trackOpportunity(candidate, 501);
      expect(obs2.visibilityDurationMs).toBe(400);
      expect(obs2.observedSnapshotsCount).toBe(2);

      // Observation 3: 1200ms after start
      candidate.timestamp = 1001200;
      const obs3 = tracker.trackOpportunity(candidate, 503);
      expect(obs3.visibilityDurationMs).toBe(1200);
      expect(obs3.observedSnapshotsCount).toBe(3);

      // Verify lifecycle stats
      const stats = tracker.getLifecycleStats();
      expect(stats.totalTrackedOpportunities).toBe(1);
      expect(stats.activeOpportunitiesCount).toBe(1);
      expect(stats.maxVisibilityDurationMs).toBe(1200);
      expect(stats.p50DurationMs).toBe(1200);
    });

    it('Matrix 1.2-N: Stale opportunity purge archives lifecycles', () => {
      const tracker = new OpportunityTracker();

      const candidate: ArbitrageCandidate = {
        candidateId: 'opp-stale',
        routeName: 'Test Route',
        direction: 'USDC->WSOL->USDC',
        cycleType: '2_LEG',
        timestamp: Date.now() - 20000, // 20s ago
        status: 'QUALIFIED_SHADOW',
        qualityLabel: 'SHADOW_QUALIFIED',
        executionProbability: 'UNCALIBRATED',
        inputAmountUSDC: 100000000n,
        optimalSizeUSDC: 100,
        leg1ExpectedOutWSOL: 606000000n,
        leg1ConservativeOutWSOL: 605394000n,
        leg2ExpectedOutUSDC: 101000000n,
        leg2ConservativeOutUSDC: 100899000n,
        expectedNetUSDC: '0.75',
        minConservativeNetUSDC: '0.65',
        rejectionReasons: [],
        quoteAgeMs: 20,
        slotGap: 0,
        leg1Quote: { poolId: 'pool-stale-a', dex: 'RAYDIUM_AMM' } as any,
        leg2Quote: { poolId: 'pool-stale-b', dex: 'ORCA_WHIRLPOOL' } as any,
        costs: {} as any
      };

      tracker.trackOpportunity(candidate, 1000);
      expect(tracker.getAllActiveOpportunities().length).toBe(1);

      // Purge opportunities older than 5 seconds
      tracker.purgeStaleOpportunities(5000);

      expect(tracker.getAllActiveOpportunities().length).toBe(0);
      const stats = tracker.getLifecycleStats();
      expect(stats.totalTrackedOpportunities).toBe(1); // Archived
      expect(stats.activeOpportunitiesCount).toBe(0);
    });
  });
});
