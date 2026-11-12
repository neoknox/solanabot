import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter, tickIndexToSqrtPriceX64 } from '../src/dex/orcaWhirlpoolAdapter.js';
import { MeteoraDlmmAdapter } from '../src/dex/meteoraDlmmAdapter.js';
import { CostModel } from '../src/profit/costModel.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { loadConfig, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';
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

    it('tickIndexToSqrtPriceX64 matches high-precision Decimal reference without IEEE 754 drift', () => {
      // Test known tick indices
      const testTicks = [-443636, -24988, -19800, 0, 19800, 24988, 443636];

      for (const tick of testTicks) {
        const result = tickIndexToSqrtPriceX64(tick);
        expect(result).toBeGreaterThan(0n);

        // Verify that 50-digit precision Decimal calculation produces the exact same integer
        const q64 = new Decimal(2).pow(64);
        const refSqrt = new Decimal(1.0001).pow(new Decimal(tick).div(2)).mul(q64).floor();
        expect(result).toBe(BigInt(refSqrt.toFixed(0)));
      }
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
});
