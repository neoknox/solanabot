import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter, tickIndexToSqrtPriceX64 } from '../src/dex/orcaWhirlpoolAdapter.js';
import { MeteoraDlmmAdapter } from '../src/dex/meteoraDlmmAdapter.js';
import { CostModel } from '../src/profit/costModel.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { CompetitorAnalyzer } from '../src/competition/analyzer.js';
import {
  loadConfig,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS,
  getKnownTokenDecimals
} from '../src/config/index.js';
import { PoolState, SwapQuote, CostBreakdown } from '../src/types/index.js';

describe('Phase 1.1 Final Gate: Independent Quote Parity & State Invariants', () => {
  const config = loadConfig();
  const costModel = new CostModel(config);
  const calculator = new ArbitrageProfitCalculator(config);

  describe('1. Raydium AMM V4 Independent Reference Quote Parity', () => {
    const adapter = new RaydiumAmmAdapter();

    // Standard mainnet-like pool snapshot with accrued protocol PnL
    const rawReserveA = 60000n * 1000000000n;   // 60,000 WSOL
    const rawReserveB = 9900000n * 1000000n;    // 9,900,000 USDC ($165/SOL)
    const basePnl = 500n * 1000000000n;         // 500 WSOL uncollected PnL
    const quotePnl = 82500n * 1000000n;         // 82,500 USDC uncollected PnL

    const effReserveA = rawReserveA - basePnl;   // 59,500 WSOL
    const effReserveB = rawReserveB - quotePnl;   // 9,817,500 USDC

    const pool: PoolState = {
      id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: rawReserveA,
      reserveB: rawReserveB,
      feeBps: 25,
      slot: 468550000,
      receivedAt: Date.now(),
      liquidityUsd: 19635000,
      feedHealth: 'HEALTHY',
      extraData: {
        baseNeedTakePnl: basePnl.toString(),
        quoteNeedTakePnl: quotePnl.toString()
      }
    };

    // Independent protocol reference calculation
    const calcRefOutput = (inAmount: bigint, resIn: bigint, resOut: bigint, feeBps: number): { outAmount: bigint; feeAmount: bigint } => {
      const feeAmount = (inAmount * BigInt(feeBps)) / 10000n;
      const inAfterFee = inAmount - feeAmount;
      const outAmount = (resOut * inAfterFee) / (resIn + inAfterFee);
      return { outAmount, feeAmount };
    };

    it('Matches independent reference outputs for USDC -> WSOL across multiple trade sizes', () => {
      const testSizesUSDC = [25000000n, 100000000n, 500000000n, 1000000000n]; // $25, $100, $500, $1,000

      for (const amountIn of testSizesUSDC) {
        const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, amountIn);
        expect(quote).not.toBeNull();

        const ref = calcRefOutput(amountIn, effReserveB, effReserveA, 25);
        expect(quote!.outAmount).toBe(ref.outAmount);
        expect(quote!.feeAmount).toBe(ref.feeAmount);
        expect(quote!.inputMint).toBe(CANONICAL_USDC_MINT);
        expect(quote!.outputMint).toBe(CANONICAL_WSOL_MINT);
      }
    });

    it('Matches independent reference outputs for WSOL -> USDC across multiple trade sizes', () => {
      const testSizesWSOL = [150000000n, 600000000n, 3000000000n, 6000000000n]; // ~0.15 SOL, 0.6 SOL, 3 SOL, 6 SOL

      for (const amountIn of testSizesWSOL) {
        const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, amountIn);
        expect(quote).not.toBeNull();

        const ref = calcRefOutput(amountIn, effReserveA, effReserveB, 25);
        expect(quote!.outAmount).toBe(ref.outAmount);
        expect(quote!.feeAmount).toBe(ref.feeAmount);
        expect(quote!.inputMint).toBe(CANONICAL_WSOL_MINT);
        expect(quote!.outputMint).toBe(CANONICAL_USDC_MINT);
      }
    });

    it('Fails closed on missing or unhydrated reserves', () => {
      const emptyPool: PoolState = { ...pool, reserveA: 0n, reserveB: 0n };
      expect(adapter.quoteExactInput(emptyPool, CANONICAL_USDC_MINT, 100000000n)).toBeNull();
    });

    it('Rejects input mints other than pool tokenAMint or tokenBMint with INVALID_MINT', () => {
      const invalidMint = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const quote = adapter.quoteExactInput(pool, invalidMint, 100000000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('INVALID_MINT');
    });

    it('Uses on-chain swapFeeNumerator and swapFeeDenominator as full rational BigInt fraction', () => {
      // Custom rational fee: 250 numerator / 100,000 denominator (25 bps) vs 350 / 100,000 (35 bps)
      const customFeePool: PoolState = {
        ...pool,
        feeBps: 35,
        extraData: {
          ...pool.extraData,
          swapFeeNumerator: '350',
          swapFeeDenominator: '100000'
        }
      };
      const amountIn = 100000000n; // $100 USDC
      const quote = adapter.quoteExactInput(customFeePool, CANONICAL_USDC_MINT, amountIn);
      expect(quote).not.toBeNull();
      expect(quote!.feeAmount).toBe((amountIn * 350n) / 100000n); // 350,000 units = 0.35 USDC
    });

    it('Marks quote as UNVERIFIED with BLOCKED_RPC_TIMEOUT when OpenOrders account verification is incomplete', () => {
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 100000000n);
      expect(quote).not.toBeNull();
      expect(quote!.quoteSource).toBe('UNVERIFIED');
      expect(quote!.executionType).toBe('INDICATIVE_ONLY');
      expect((quote as any).isUnverified).toBe(true);
      expect((quote as any).unverifiedReason).toBe('BLOCKED_RPC_TIMEOUT');

      // Evaluator must reject this quote as UNSUPPORTED / INDICATIVE_ONLY with reason QUOTE_UNVERIFIED
      const costs = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0),
        solPriceTimestamp: Date.now()
      }).breakdown!;

      const candidate = calculator.evaluateCandidate({
        initialAmountUSDC: 100000000n,
        leg1Quote: quote!,
        leg2Quote: quote!,
        cycleType: '2_LEG',
        costs,
        currentSlot: 468550000,
        wsConnected: true,
        solPriceTimestamp: Date.now()
      });
      expect(candidate.status).toBe('UNSUPPORTED');
      expect(candidate.qualityLabel).toBe('INDICATIVE_ONLY');
      expect(candidate.rejectionReasons).toContain('QUOTE_UNVERIFIED');
    });

    it('Marks quote as DIRECT_POOL and POTENTIAL_ATOMIC when OpenOrders is verified', () => {
      const verifiedPool: PoolState = {
        ...pool,
        extraData: {
          ...pool.extraData,
          openOrdersVerified: true
        }
      };
      const quote = adapter.quoteExactInput(verifiedPool, CANONICAL_USDC_MINT, 100000000n);
      expect(quote).not.toBeNull();
      expect(quote!.quoteSource).toBe('DIRECT_POOL');
      expect(quote!.executionType).toBe('POTENTIAL_ATOMIC');
      expect((quote as any).isUnverified).toBeFalsy();
    });
  });

  describe('2. Orca Whirlpool Fixed-Point Math & Active Tick Parity', () => {
    const adapter = new OrcaWhirlpoolAdapter();

    it('tickIndexToSqrtPriceX64 matches official on-chain Orca Whirlpool Rust test vectors', () => {
      // Vector 1: tick 0 -> exact 2^64
      const tick0 = tickIndexToSqrtPriceX64(0);
      expect(tick0).toBe(18446744073709551616n); // 1n << 64n

      // Vector 2: MIN_TICK_INDEX = -443636 -> exact official MIN_SQRT_PRICE_X64
      const minTick = tickIndexToSqrtPriceX64(-443636);
      expect(minTick).toBe(4295048016n); // Official Orca Whirlpool on-chain constant

      // Vector 3: Active mainnet SOL/USDC Whirlpool tick -24988 boundary
      const activeTick = tickIndexToSqrtPriceX64(-24988);
      expect(activeTick).toBe(5288583008912297376n); // Official Orca Whirlpool core integer constant
      // The on-chain active sqrtPrice (5288671865725992663) strictly resides within [tick(-24988), tick(-24987))
      const nextTick = tickIndexToSqrtPriceX64(-24987);
      const onChainSqrtPrice = 5288671865725992663n;
      expect(activeTick <= onChainSqrtPrice && onChainSqrtPrice < nextTick).toBe(true);

      // Vector 4: MAX_TICK_INDEX = 443636
      // Official Rust binary lookup yields 79226673515401279992447579055n; exact zero-drift parity
      const maxTick = tickIndexToSqrtPriceX64(443636);
      expect(maxTick).toBe(79226673515401279992447579055n);
    });

    it('Single-tick exact output matches concentrated liquidity formula in both directions', () => {
      const pool: PoolState = {
        id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: 468550000,
        receivedAt: Date.now(),
        liquidityUsd: 32000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: -24988,
          tickSpacing: 4,
          feeRateRaw: 400, // 4 bps
          sqrtPrice: '5288671865725992663',
          liquidity: '430523504655045'
        }
      };

      // Test Direction 1: USDC -> WSOL ($25 trade)
      const quoteUSDCtoWSOL = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 25000000n);
      expect(quoteUSDCtoWSOL).not.toBeNull();
      expect(quoteUSDCtoWSOL!.outAmount).toBe(304027150n); // Exact raw base units (0.304027150 SOL)
      expect(quoteUSDCtoWSOL!.feeAmount).toBe(10000n);     // 4 bps

      // Test Direction 2: WSOL -> USDC (~0.15 SOL trade)
      const quoteWSOLtoUSDC = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteWSOLtoUSDC).not.toBeNull();
      expect(quoteWSOLtoUSDC!.outAmount).toBe(12324555n);  // Exact raw base units ($12.324555 USDC)
      expect(quoteWSOLtoUSDC!.feeAmount).toBe(60000n);     // 4 bps
    });

    it('Fails closed when trade crosses tick boundary without tick arrays', () => {
      const poolNarrow: PoolState = {
        id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: 468550000,
        receivedAt: Date.now(),
        liquidityUsd: 10000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: -24988,
          tickSpacing: 4,
          feeRateRaw: 400,
          sqrtPrice: '5288671865725992663',
          liquidity: '1000000' // Minimal liquidity forces immediate tick crossing
        }
      };

      const crossedQuote = adapter.quoteExactInput(poolNarrow, CANONICAL_USDC_MINT, 500000000n);
      expect(crossedQuote).toBeNull();
    });

    it('Multi-tick quoting successfully traverses tick boundaries for $25, $50, $100, $250, $500, $1000 probes when tick arrays are loaded', () => {
      // Build 3 consecutive tick arrays around active tick -25068 (spacing 4 -> delta 352)
      // Ticks: [-25344, -24992, -24640]
      const createMockTickArray = (startTickIndex: number): any => {
        const ticks = [];
        for (let i = 0; i < 88; i++) {
          ticks.push({
            initialized: i % 4 === 0, // regular initialized tick boundaries
            liquidityNet: 0n,
            liquidityGross: i % 4 === 0 ? 500000000000000n : 0n,
            feeGrowthOutsideA: 0n,
            feeGrowthOutsideB: 0n,
            rewardGrowthsOutside: [0n, 0n, 0n]
          });
        }
        return { startTickIndex, ticks };
      };

      const tickArraysMap: Record<number, any> = {
        [-25344]: createMockTickArray(-25344),
        [-24992]: createMockTickArray(-24992),
        [-24640]: createMockTickArray(-24640),
        [-25696]: createMockTickArray(-25696),
        [-26048]: createMockTickArray(-26048)
      };

      const multiTickPool: PoolState = {
        id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: 468700000,
        receivedAt: Date.now(),
        liquidityUsd: 50000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: -25068,
          tickSpacing: 4,
          feeRate: 400,
          feeRateRaw: 400,
          protocolFeeRate: 1300,
          feeTierIndexSeed: [4, 0],
          sqrtPrice: '5267498573947197513',
          liquidity: '465467525220858',
          tickArrays: tickArraysMap
        }
      };

      // Test configured probe sizes: $25, $50, $100, $250, $500, $1000 in both directions
      const probeSizesUSDC = [25, 50, 100, 250, 500, 1000];

      // Direction 1: USDC -> WSOL
      for (const size of probeSizesUSDC) {
        const inAmount = BigInt(size * 1e6);
        const quote = adapter.quoteExactInput(multiTickPool, CANONICAL_USDC_MINT, inAmount);
        expect(quote).not.toBeNull();
        expect(quote!.outAmount).toBeGreaterThan(0n);
        expect(quote!.feeAmount).toBe((inAmount * 400n) / 1000000n);
        expect(quote!.quoteSource).toBe('DIRECT_POOL');
        expect(quote!.executionType).toBe('POTENTIAL_ATOMIC');
      }

      // Direction 2: WSOL -> USDC
      for (const size of probeSizesUSDC) {
        const solLamports = BigInt(Math.floor((size / 160) * 1e9));
        const quote = adapter.quoteExactInput(multiTickPool, CANONICAL_WSOL_MINT, solLamports);
        expect(quote).not.toBeNull();
        expect(quote!.outAmount).toBeGreaterThan(0n);
        expect(quote!.feeAmount).toBe((solLamports * 400n) / 1000000n);
        expect(quote!.quoteSource).toBe('DIRECT_POOL');
        expect(quote!.executionType).toBe('POTENTIAL_ATOMIC');
      }
    });

    it('Rejects invalid input mint with INVALID_MINT failure reason', () => {
      const pool: PoolState = {
        id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: 468550000,
        receivedAt: Date.now(),
        liquidityUsd: 10000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: -24988,
          tickSpacing: 4,
          feeRateRaw: 400,
          sqrtPrice: '5288671865725992663',
          liquidity: '100000000'
        }
      };

      const invalidQuote = adapter.quoteExactInput(pool, 'InvalidMint1111111111111111111111111111111111', 1000000n);
      expect(invalidQuote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('INVALID_MINT');
    });
  });

  describe('3. Meteora DLMM Quote Gate & Missing Bin Arrays', () => {
    const adapter = new MeteoraDlmmAdapter();

    it('Strictly returns null when verified bin arrays are missing (prohibits mathematical approximations)', () => {
      const unverifiedPool: PoolState = {
        id: 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR',
        dex: 'METEORA_DLMM',
        programId: KNOWN_PROGRAM_IDS.METEORA_DLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 10,
        slot: 100,
        receivedAt: Date.now(),
        liquidityUsd: 500000,
        feedHealth: 'HEALTHY',
        extraData: {
          binStep: 10,
          activeId: -24955,
          hasVerifiedBinArrays: false
        }
      };

      expect(adapter.quoteExactInput(unverifiedPool, CANONICAL_USDC_MINT, 100000000n)).toBeNull();
    });
  });

  describe('4. Freshness, Timestamp & Account Invariants', () => {
    it('Missing, zero, future, or stale timestamps fail closed', () => {
      // 1. Missing timestamp
      const noTs = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0)
      });
      expect(noTs.isComplete).toBe(false);
      expect(noTs.missingReason).toContain('Missing or zero SOL price timestamp');

      // 2. Zero timestamp
      const zeroTs = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0),
        solPriceTimestamp: 0
      });
      expect(zeroTs.isComplete).toBe(false);

      // 3. Future timestamp
      const futureTs = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0),
        solPriceTimestamp: Date.now() + 60000
      });
      expect(futureTs.isComplete).toBe(false);
      expect(futureTs.missingReason).toContain('future');

      // 4. Stale timestamp (> 10s old)
      const staleTs = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0),
        solPriceTimestamp: Date.now() - 30000
      });
      expect(staleTs.isComplete).toBe(false);
      expect(staleTs.missingReason).toContain('stale');
    });

    it('Discloses that Phase 1.1 execution fees are ESTIMATED prior to on-chain composition', () => {
      const valid = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0),
        solPriceTimestamp: Date.now()
      });
      expect(valid.isComplete).toBe(true);
      expect(valid.breakdown!.assumptions.some(a => a.includes('ESTIMATED'))).toBe(true);
    });
  });

  describe('5. Verified Route Recovery Regressions & Attributions', () => {
    it('Regression: Verified mint metadata assigns WSOL 9, USDC 6, USDT 6 (no assumption that token B is always 9)', () => {
      expect(getKnownTokenDecimals(CANONICAL_WSOL_MINT)).toBe(9);
      expect(getKnownTokenDecimals(CANONICAL_USDC_MINT)).toBe(6);
      expect(getKnownTokenDecimals(CANONICAL_USDT_MINT)).toBe(6);

      // Create dummy 653-byte Orca pool data for USDC/USDT
      const buf = Buffer.alloc(653);
      buf.writeUInt16LE(1, 41); // tickSpacing: 1
      buf.writeUInt16LE(100, 43); // feeRateRaw: 100 (1 bps)
      new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(buf, 101); // tokenMintA: USDC
      new PublicKey(CANONICAL_USDT_MINT).toBuffer().copy(buf, 181); // tokenMintB: USDT

      const adapter = new OrcaWhirlpoolAdapter();
      const decoded = adapter.decodePoolState(buf, 'usdc-usdt-pool', 100);
      expect(decoded).not.toBeNull();
      expect(decoded!.tokenADecimals).toBe(6);
      expect(decoded!.tokenBDecimals).toBe(6); // Must be 6, NOT 9!
    });

    it('Separate Rejection Attribution: Unverified routes do NOT claim LOW_CONSERVATIVE_NET', () => {
      const raydiumAdapter = new RaydiumAmmAdapter();
      const unverifiedPool: PoolState = {
        id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 60000000000000n,
        reserveB: 9900000000000n,
        feeBps: 25,
        slot: 100,
        receivedAt: Date.now(),
        liquidityUsd: 19000000,
        feedHealth: 'HEALTHY',
        extraData: {
          openOrdersVerified: false // Unverified
        }
      };

      const quote = raydiumAdapter.quoteExactInput(unverifiedPool, CANONICAL_USDC_MINT, 100000000n);
      expect(quote).not.toBeNull();
      expect((quote as any).isUnverified).toBe(true);

      const costs = costModel.calculateCosts({
        solPriceUSDC: new Decimal(165.0),
        solPriceTimestamp: Date.now()
      }).breakdown!;

      const candidate = calculator.evaluateCandidate({
        initialAmountUSDC: 100000000n,
        leg1Quote: quote!,
        leg2Quote: quote!,
        cycleType: '2_LEG',
        costs,
        currentSlot: 100,
        wsConnected: true,
        solPriceTimestamp: Date.now()
      });

      expect(candidate.status).toBe('UNSUPPORTED');
      expect(candidate.rejectionReasons).toContain('QUOTE_UNVERIFIED');
      expect(candidate.rejectionReasons).toContain('UNSUPPORTED_ROUTE');
      // Crucial: Must NOT contain LOW_CONSERVATIVE_NET!
      expect(candidate.rejectionReasons).not.toContain('LOW_CONSERVATIVE_NET');
    });

    it('Fail-closed: Missing or zero pool.receivedAt fails closed (returns null)', () => {
      const orcaAdapter = new OrcaWhirlpoolAdapter();
      const stalePool: PoolState = {
        id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: 100,
        receivedAt: 0, // Missing / zero timestamp
        liquidityUsd: 32000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: -24988,
          tickSpacing: 4,
          sqrtPrice: '5288671865725992663',
          liquidity: '430523504655045'
        }
      };

      // Fails closed on quote calculation
      const quote = orcaAdapter.quoteExactInput(stalePool, CANONICAL_USDC_MINT, 100000000n);
      expect(quote).toBeNull();
    });

    it('Contention Honesty: Zero observed transactions yields UNKNOWN contention and 0 fee distributions', () => {
      const analyzer = new CompetitorAnalyzer();
      const metrics = analyzer.getDefaultMetrics('dummy-pool');

      expect(metrics.totalObservedTx).toBe(0);
      expect(metrics.contentionLevel).toBe('UNKNOWN');
      expect(metrics.historicalCompetitionScore).toBe(0);
      expect(metrics.feeDistributionLamports.p50).toBe(0);
      expect(metrics.priorityFeeStatsMicroLamports.p50).toBe(0);
      expect(metrics.arbitrageLoopFrequencyPerHour).toBe(0);
    });
  });
});
