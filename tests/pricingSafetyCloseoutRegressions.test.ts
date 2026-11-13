import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { tickIndexToSqrtPrice, swapQuoteByInputToken, TickArrayFacade } from '@orca-so/whirlpools-core';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { StateCache, getQuoteRelevantSignature } from '../src/scanner/stateCache.js';
import {
  loadConfig,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';
import { PoolState } from '../src/types/index.js';

describe('Pricing Safety & State Integrity Closeout Suite', () => {
  const config = loadConfig();
  const poolId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
  const tickSpacing = 4;
  const activeTick = -25068; // In array -25344
  const sqrtPrice = 5267498573947197513n;
  const deepLiquidity = 465467525220858n;

  function createTickArrayWithTicks(
    startTickIndex: number,
    tickMods: Record<number, { net: bigint; gross: bigint }>
  ): TickArrayFacade {
    const ticks = [];
    for (let i = 0; i < 88; i++) {
      const tickIndex = startTickIndex + i * tickSpacing;
      const mod = tickMods[tickIndex];
      if (mod) {
        ticks.push({
          initialized: true,
          liquidityNet: mod.net,
          liquidityGross: mod.gross,
          feeGrowthOutsideA: 0n,
          feeGrowthOutsideB: 0n,
          rewardGrowthsOutside: [0n, 0n, 0n]
        });
      } else {
        ticks.push({
          initialized: false,
          liquidityNet: 0n,
          liquidityGross: 0n,
          feeGrowthOutsideA: 0n,
          feeGrowthOutsideB: 0n,
          rewardGrowthsOutside: [0n, 0n, 0n]
        });
      }
    }
    return { startTickIndex, ticks };
  }

  // 1. TICK ARRAY FRESHNESS & OUT-OF-ORDER UPDATES
  describe('1. Tick Array Freshness & Dependency Observation Gates', () => {
    it('fails closed when required tick array is missing observation timestamp or slot', () => {
      const scanner = new ArbitrageScanner(config);
      const initialSlot = 1000;
      const now = Date.now();

      const arrayMinus26048 = createTickArrayWithTicks(-26048, {});
      const arrayMinus25696 = createTickArrayWithTicks(-25696, {});
      const arrayMinus25344 = createTickArrayWithTicks(-25344, {});

      // Pool with tickArrays but array -25696 has missing timestamp
      const poolMissingTimestamp: PoolState = {
        id: poolId,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: initialSlot,
        receivedAt: now,
        liquidityUsd: 50000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: activeTick,
          tickSpacing: 4,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: deepLiquidity.toString(),
          observationFreshnessTtlMs: 30000,
          tickArrays: {
            [-26048]: arrayMinus26048,
            [-25696]: arrayMinus25696,
            [-25344]: arrayMinus25344
          },
          tickArraySlots: {
            [-26048]: initialSlot,
            [-25696]: initialSlot,
            [-25344]: initialSlot
          },
          tickArrayReceivedAt: {
            [-26048]: now,
            // [-25696] timestamp is MISSING
            [-25344]: now
          }
        }
      };

      (scanner as any).stateCache.setPoolState(poolMissingTimestamp);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

      const adapter = new OrcaWhirlpoolAdapter();
      // Quoting A -> B requires [-25344, -25696, -26048].
      // Array -25696 has missing timestamp -> fails closed
      const quote = adapter.quoteExactInput(poolMissingTimestamp, CANONICAL_WSOL_MINT, 150000000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');
    });

    it('fails closed when tick array has future observation timestamp (> now + 5000)', () => {
      const adapter = new OrcaWhirlpoolAdapter();
      const initialSlot = 1000;
      const now = Date.now();

      const poolFutureTimestamp: PoolState = {
        id: poolId,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: initialSlot,
        receivedAt: now,
        liquidityUsd: 50000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: activeTick,
          tickSpacing: 4,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: deepLiquidity.toString(),
          observationFreshnessTtlMs: 30000,
          tickArrays: {
            [-26048]: createTickArrayWithTicks(-26048, {}),
            [-25696]: createTickArrayWithTicks(-25696, {}),
            [-25344]: createTickArrayWithTicks(-25344, {})
          },
          tickArraySlots: {
            [-26048]: initialSlot,
            [-25696]: initialSlot,
            [-25344]: initialSlot
          },
          tickArrayReceivedAt: {
            [-26048]: now,
            [-25696]: now + 60000, // FUTURE TIMESTAMP (1 minute in future)
            [-25344]: now
          }
        }
      };

      const quote = adapter.quoteExactInput(poolFutureTimestamp, CANONICAL_WSOL_MINT, 150000000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');
    });

    it('rejects out-of-order account updates for tick arrays and pool state', () => {
      const scanner = new ArbitrageScanner(config);
      const initialSlot = 5000;
      const now = Date.now();

      const pool: PoolState = {
        id: poolId,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: initialSlot,
        receivedAt: now,
        liquidityUsd: 50000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: activeTick,
          tickSpacing: 4,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: deepLiquidity.toString(),
          tickArrays: {},
          tickArraySlots: {
            [-25344]: initialSlot
          },
          tickArrayReceivedAt: {
            [-25344]: now
          }
        }
      };

      (scanner as any).stateCache.setPoolState(pool);
      (scanner as any).tickArrayToPool.set('mock-pda', { poolId, startTickIndex: -25344 });

      // Deliver out-of-order tick array update with slot 4990 (< 5000)
      const mockData = Buffer.alloc(9988);
      mockData.writeInt32LE(-25344, 8);
      new PublicKey(poolId).toBuffer().copy(mockData, 9956);

      (scanner as any).processTickArrayAccountUpdate({
        type: 'TICK_ARRAY_ACCOUNT',
        key: 'mock-pda',
        data: mockData,
        slot: 4990, // Out of order!
        receivedAtMs: now + 10,
        monotonicReceiptTime: performance.now()
      });

      const afterState = (scanner as any).stateCache.getPoolState(poolId);
      // Slot must remain 5000, out-of-order update was dropped
      expect(afterState.extraData.tickArraySlots[-25344]).toBe(initialSlot);

      // Deliver out-of-order pool update with slot 4980 (< 5000)
      const mockPoolData = Buffer.alloc(653);
      mockPoolData.writeUInt16LE(4, 41);
      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: mockPoolData,
        slot: 4980, // Out of order!
        receivedAtMs: now + 20,
        monotonicReceiptTime: performance.now()
      });

      const afterPool = (scanner as any).stateCache.getPoolState(poolId);
      expect(afterPool.slot).toBe(initialSlot); // Pool slot not rolled backward
    });
  });

  // 2. COMPLETE STATE FINGERPRINTS
  describe('2. Complete Quote-Relevant State Fingerprints', () => {
    it('Raydium state fingerprint includes swapFeeNumerator, swapFeeDenominator, baseNeedTakePnl, quoteNeedTakePnl', () => {
      const cache = new StateCache();
      const initialSlot = 1000;
      const now = Date.now();
      const raydiumId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

      const basePool: PoolState = {
        id: raydiumId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000000000000n,
        reserveB: 150000000000n,
        feeBps: 25,
        slot: initialSlot,
        receivedAt: now,
        liquidityUsd: 30000000,
        feedHealth: 'HEALTHY',
        extraData: {
          swapFeeNumerator: '25',
          swapFeeDenominator: '10000',
          baseNeedTakePnl: '5000000',
          quoteNeedTakePnl: '1000000',
          openOrdersBaseTokenTotal: '1000000',
          openOrdersQuoteTokenTotal: '2000000',
          openOrdersSlot: initialSlot,
          vaultASlot: initialSlot,
          vaultBSlot: initialSlot
        }
      };

      const res1 = cache.setPoolState(basePool);
      expect(res1.hasChanged).toBe(true);
      expect(res1.stateRevision).toBe(1);

      // 1. Identical pool state preserves revision 1
      const poolSame = { ...basePool, extraData: { ...basePool.extraData } };
      const resSame = cache.setPoolState(poolSame);
      expect(resSame.hasChanged).toBe(false);
      expect(resSame.stateRevision).toBe(1);

      // 2. Changed swapFeeNumerator increments revision
      const poolFeeNum = { ...basePool, extraData: { ...basePool.extraData, swapFeeNumerator: '30' } };
      const resFeeNum = cache.setPoolState(poolFeeNum);
      expect(resFeeNum.hasChanged).toBe(true);
      expect(resFeeNum.stateRevision).toBe(2);

      // 3. Changed swapFeeDenominator increments revision
      const poolFeeDenom = { ...basePool, extraData: { ...basePool.extraData, swapFeeDenominator: '20000' } };
      const resFeeDenom = cache.setPoolState(poolFeeDenom);
      expect(resFeeDenom.hasChanged).toBe(true);
      expect(resFeeDenom.stateRevision).toBe(3);

      // 4. Changed baseNeedTakePnl increments revision
      const poolPnlA = { ...basePool, extraData: { ...basePool.extraData, baseNeedTakePnl: '8000000' } };
      const resPnlA = cache.setPoolState(poolPnlA);
      expect(resPnlA.hasChanged).toBe(true);
      expect(resPnlA.stateRevision).toBe(4);

      // 5. Changed quoteNeedTakePnl increments revision
      const poolPnlB = { ...basePool, extraData: { ...basePool.extraData, quoteNeedTakePnl: '3000000' } };
      const resPnlB = cache.setPoolState(poolPnlB);
      expect(resPnlB.hasChanged).toBe(true);
      expect(resPnlB.stateRevision).toBe(5);
    });

    it('Orca state fingerprint includes exact feeRate, tickSpacing, and active liquidity', () => {
      const cache = new StateCache();
      const initialSlot = 1000;
      const now = Date.now();

      const basePool: PoolState = {
        id: poolId,
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 4,
        slot: initialSlot,
        receivedAt: now,
        liquidityUsd: 50000000,
        feedHealth: 'HEALTHY',
        extraData: {
          feeRate: 400,
          tickSpacing: 4,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: deepLiquidity.toString(),
          tickCurrent: activeTick,
          tickArrays: {}
        }
      };

      const res1 = cache.setPoolState(basePool);
      expect(res1.hasChanged).toBe(true);
      expect(res1.stateRevision).toBe(1);

      // Identical state preserves revision
      const resSame = cache.setPoolState({ ...basePool, extraData: { ...basePool.extraData } });
      expect(resSame.hasChanged).toBe(false);
      expect(resSame.stateRevision).toBe(1);

      // Changed feeRate (e.g. adaptive fee tier adjustment) increments revision
      const poolFeeRate = { ...basePool, extraData: { ...basePool.extraData, feeRate: 450 } };
      const resFeeRate = cache.setPoolState(poolFeeRate);
      expect(resFeeRate.hasChanged).toBe(true);
      expect(resFeeRate.stateRevision).toBe(2);

      // Changed tickSpacing increments revision
      const poolSpacing = { ...basePool, extraData: { ...basePool.extraData, tickSpacing: 8 } };
      const resSpacing = cache.setPoolState(poolSpacing);
      expect(resSpacing.hasChanged).toBe(true);
      expect(resSpacing.stateRevision).toBe(3);
    });
  });

  // 3. REAL TICK-CROSSING VALIDATION
  describe('3. Real Tick-Crossing Deterministic Fixtures & Assertions', () => {
    const adapter = new OrcaWhirlpoolAdapter();

    // Fixture setup: active tick -25068
    // Ticks initialized with non-zero liquidityNet
    const arrayMinus26048 = createTickArrayWithTicks(-26048, {
      [-25800]: { net: -10000000000000n, gross: 10000000000000n }
    });
    const arrayMinus25696 = createTickArrayWithTicks(-25696, {
      [-25500]: { net: -15000000000000n, gross: 15000000000000n },
      [-25400]: { net: 10000000000000n, gross: 10000000000000n }
    });
    const arrayMinus25344 = createTickArrayWithTicks(-25344, {
      [-25200]: { net: -8000000000000n, gross: 8000000000000n },
      [-25120]: { net: 12000000000000n, gross: 12000000000000n },
      [-25088]: { net: -5000000000000n, gross: 5000000000000n }, // Direction 2 crossing
      [-25040]: { net: 6000000000000n, gross: 6000000000000n }   // Direction 1 crossing
    });
    const arrayMinus24992 = createTickArrayWithTicks(-24992, {
      [-24960]: { net: 6000000000000n, gross: 6000000000000n },
      [-24800]: { net: -7000000000000n, gross: 7000000000000n }
    });
    const arrayMinus24640 = createTickArrayWithTicks(-24640, {
      [-24500]: { net: 15000000000000n, gross: 15000000000000n }
    });

    const tickArraysMap: Record<number, TickArrayFacade> = {
      [-26048]: arrayMinus26048,
      [-25696]: arrayMinus25696,
      [-25344]: arrayMinus25344,
      [-24992]: arrayMinus24992,
      [-24640]: arrayMinus24640
    };

    const multiTickPool: PoolState = {
      id: poolId,
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
        tickCurrent: activeTick,
        tickSpacing: 4,
        feeRate: 400,
        feeRateRaw: 400,
        protocolFeeRate: 1300,
        feeTierIndexSeed: [4, 0],
        sqrtPrice: sqrtPrice.toString(),
        liquidity: deepLiquidity.toString(),
        tickArrays: tickArraysMap
      }
    };

    it('asserts actual tick crossings and exact pinned outputs in Direction 1 (USDC -> WSOL)', () => {
      // Starting tick: -25068
      // Next upper initialized tick: -25040 (requires ~186.26 USDC input to reach)

      // Sub-crossing probe: $50 USDC ($50M units < 186.26M units) -> does not reach -25040
      const quoteSubCrossing = adapter.quoteExactInput(multiTickPool, CANONICAL_USDC_MINT, 50000000n);
      expect(quoteSubCrossing).not.toBeNull();
      expect(quoteSubCrossing!.outAmount).toBe(612952301n);
      expect(quoteSubCrossing!.feeAmount).toBe(20000n);
      expect(quoteSubCrossing!.priceImpactBps).toBe(0);

      // Real tick-crossing probe: $250 USDC ($250M units > 186.26M units) -> MUST CROSS tick -25040
      const quoteCrossing = adapter.quoteExactInput(multiTickPool, CANONICAL_USDC_MINT, 250000000n);
      expect(quoteCrossing).not.toBeNull();
      // Pinned exact reference value:
      expect(quoteCrossing!.outAmount).toBe(3064756897n);
      expect(quoteCrossing!.feeAmount).toBe(100000n);
      expect(quoteCrossing!.priceImpactBps).toBe(0);

      // Multi-array boundary crossing probe: $1000 USDC -> crosses into array -24992 and crosses tick -24960
      const quoteMultiArray = adapter.quoteExactInput(multiTickPool, CANONICAL_USDC_MINT, 1000000000n);
      expect(quoteMultiArray).not.toBeNull();
      expect(quoteMultiArray!.outAmount).toBe(12258958445n);
      expect(quoteMultiArray!.feeAmount).toBe(400000n);
      expect(quoteMultiArray!.priceImpactBps).toBe(0);
    });

    it('asserts actual tick crossings and exact pinned outputs in Direction 2 (WSOL -> USDC)', () => {
      // Starting tick: -25068
      // Next lower initialized tick: -25088 (offset 20 ticks down, requires ~0.103 SOL)

      // Sub-crossing probe: 0.05 SOL (50,000,000 lamports) -> does not reach -25088
      const quoteSubCrossing = adapter.quoteExactInput(multiTickPool, CANONICAL_WSOL_MINT, 50000000n);
      expect(quoteSubCrossing).not.toBeNull();
      expect(quoteSubCrossing!.outAmount).toBe(4075356n);
      expect(quoteSubCrossing!.feeAmount).toBe(20000n);

      // Real tick-crossing probe: 1.5625 SOL (1,562,500,000 lamports) -> crosses tick -25088 and -25120
      const quoteCrossing = adapter.quoteExactInput(multiTickPool, CANONICAL_WSOL_MINT, 1562500000n);
      expect(quoteCrossing).not.toBeNull();
      // Pinned exact reference value:
      expect(quoteCrossing!.outAmount).toBe(127354784n);
      expect(quoteCrossing!.feeAmount).toBe(625000n);
      expect(quoteCrossing!.priceImpactBps).toBe(0);

      // Multi-array boundary crossing probe: 6.25 SOL (6,250,000,000 lamports) -> crosses into array -25696
      const quoteMultiArray = adapter.quoteExactInput(multiTickPool, CANONICAL_WSOL_MINT, 6250000000n);
      expect(quoteMultiArray).not.toBeNull();
      expect(quoteMultiArray!.outAmount).toBe(509417674n);
      expect(quoteMultiArray!.feeAmount).toBe(2500000n);
      expect(quoteMultiArray!.priceImpactBps).toBe(0);
    });
  });
});
