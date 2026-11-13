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

    it('fails closed with MISSING_TICK_DATA when BOTH tickArrayReceivedAt and tickArraySlots collections are absent, or when either collection is missing', () => {
      const adapter = new OrcaWhirlpoolAdapter();
      const initialSlot = 1000;
      const now = Date.now();

      const arrayMinus26048 = createTickArrayWithTicks(-26048, {});
      const arrayMinus25696 = createTickArrayWithTicks(-25696, {});
      const arrayMinus25344 = createTickArrayWithTicks(-25344, {});

      // Case 1: BOTH metadata collections are absent
      const poolBothAbsent: PoolState = {
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
          }
          // Neither tickArrayReceivedAt nor tickArraySlots provided
        }
      };

      const quoteBoth = adapter.quoteExactInput(poolBothAbsent, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteBoth).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');

      // Case 2: tickArrayReceivedAt is present, but tickArraySlots collection is absent
      const poolSlotsAbsent: PoolState = {
        ...poolBothAbsent,
        extraData: {
          ...poolBothAbsent.extraData,
          tickArrayReceivedAt: {
            [-26048]: now,
            [-25696]: now,
            [-25344]: now
          }
        }
      };
      const quoteSlotsAbsent = adapter.quoteExactInput(poolSlotsAbsent, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteSlotsAbsent).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');

      // Case 3: tickArraySlots is present, but tickArrayReceivedAt collection is absent
      const poolTimestampsAbsent: PoolState = {
        ...poolBothAbsent,
        extraData: {
          ...poolBothAbsent.extraData,
          tickArraySlots: {
            [-26048]: initialSlot,
            [-25696]: initialSlot,
            [-25344]: initialSlot
          }
        }
      };
      const quoteTimestampsAbsent = adapter.quoteExactInput(poolTimestampsAbsent, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteTimestampsAbsent).toBeNull();
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
    const realisticLiquidity = 50000000000n; // 50B units concentrated liquidity
    const sqrtPriceVal = 5267471982609597336n; // activeTick -25068
    const now = Date.now();
    const slot = 468700000;

    // Direction 1 Arrays (active tick -25068 in -25344, price moving up: -25344 -> -24992 -> -24640):
    // 1. tick -25040 has +25B liquidityNet (requires ~20.00 USDC to reach)
    const arrayMinus25344_d1 = createTickArrayWithTicks(-25344, {
      [-25040]: { net: 25000000000n, gross: 25000000000n }
    });
    // 2. tick -24960 in array -24992 has +25B liquidityNet (requires ~105.83 USDC cumulative to reach)
    const arrayMinus24992_d1 = createTickArrayWithTicks(-24992, {
      [-24960]: { net: 25000000000n, gross: 25000000000n }
    });
    const arrayMinus24640_d1 = createTickArrayWithTicks(-24640, {});

    // Counterfactual uninitialized arrays for proving SDK state transition
    const arrayMinus25344_d1_empty = createTickArrayWithTicks(-25344, {});
    const arrayMinus24992_d1_empty = createTickArrayWithTicks(-24992, {});

    const poolD1: PoolState = {
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
      slot,
      receivedAt: now,
      liquidityUsd: 50000000,
      feedHealth: 'HEALTHY',
      extraData: {
        tickCurrent: activeTick,
        tickSpacing: 4,
        feeRate: 400,
        feeRateRaw: 400,
        protocolFeeRate: 0,
        feeTierIndexSeed: [4, 0],
        sqrtPrice: sqrtPriceVal.toString(),
        liquidity: realisticLiquidity.toString(),
        tickArrays: {
          [-25344]: arrayMinus25344_d1,
          [-24992]: arrayMinus24992_d1,
          [-24640]: arrayMinus24640_d1
        },
        tickArrayReceivedAt: {
          [-25344]: now,
          [-24992]: now,
          [-24640]: now
        },
        tickArraySlots: {
          [-25344]: slot,
          [-24992]: slot,
          [-24640]: slot
        }
      }
    };

    // Direction 2 Arrays (active tick -25068 in -25344, price moving down: -25344 -> -25696 -> -26048):
    // 1. tick -25088 has -25B liquidityNet (requires ~0.175 SOL to reach; crossing down subtracts -25B => +25B liquidity)
    const arrayMinus25344_d2 = createTickArrayWithTicks(-25344, {
      [-25088]: { net: -25000000000n, gross: 25000000000n }
    });
    // 2. tick -25400 in lower array -25696 has -25B liquidityNet (requires ~4.31 SOL cumulative to reach)
    const arrayMinus25696_d2 = createTickArrayWithTicks(-25696, {
      [-25400]: { net: -25000000000n, gross: 25000000000n }
    });
    const arrayMinus26048_d2 = createTickArrayWithTicks(-26048, {});

    // Counterfactual uninitialized arrays for proving Direction 2 SDK state transition
    const arrayMinus25344_d2_empty = createTickArrayWithTicks(-25344, {});
    const arrayMinus25696_d2_empty = createTickArrayWithTicks(-25696, {});

    const poolD2: PoolState = {
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
      slot,
      receivedAt: now,
      liquidityUsd: 50000000,
      feedHealth: 'HEALTHY',
      extraData: {
        tickCurrent: activeTick,
        tickSpacing: 4,
        feeRate: 400,
        feeRateRaw: 400,
        protocolFeeRate: 0,
        feeTierIndexSeed: [4, 0],
        sqrtPrice: sqrtPriceVal.toString(),
        liquidity: realisticLiquidity.toString(),
        tickArrays: {
          [-25344]: arrayMinus25344_d2,
          [-25696]: arrayMinus25696_d2,
          [-26048]: arrayMinus26048_d2
        },
        tickArrayReceivedAt: {
          [-25344]: now,
          [-25696]: now,
          [-26048]: now
        },
        tickArraySlots: {
          [-25344]: slot,
          [-25696]: slot,
          [-26048]: slot
        }
      }
    };

    it('asserts actual tick crossings and exact pinned outputs in Direction 1 (USDC -> WSOL)', () => {
      // Starting tick: -25068
      // Next upper initialized tick: -25040 (requires ~20.00 USDC input to reach at L=50B)

      // 1. Sub-crossing probe: $10 USDC ($10M units < 20M units) -> 0 ticks crossed
      const quoteSubCrossing = adapter.quoteExactInput(poolD1, CANONICAL_USDC_MINT, 10000000n);
      expect(quoteSubCrossing).not.toBeNull();
      expect(quoteSubCrossing!.outAmount).toBe(122505974n);
      expect(quoteSubCrossing!.feeAmount).toBe(4000n);
      expect(quoteSubCrossing!.priceImpactBps).toBe(6);

      // Prove no tick was crossed: identical output to counterfactual empty array
      const poolD1Empty1: PoolState = {
        ...poolD1,
        extraData: {
          ...poolD1.extraData,
          tickArrays: { [-25344]: arrayMinus25344_d1_empty, [-24992]: arrayMinus24992_d1_empty, [-24640]: arrayMinus24640_d1 }
        }
      };
      const quoteSubEmpty = adapter.quoteExactInput(poolD1Empty1, CANONICAL_USDC_MINT, 10000000n);
      expect(quoteSubEmpty!.outAmount).toBe(122505974n);
      expect(quoteSubCrossing!.outAmount).toBe(quoteSubEmpty!.outAmount);

      // 2. Real tick-crossing probe: $50 USDC ($50M units > 20M units) -> MUST CROSS tick -25040
      const quoteCrossing = adapter.quoteExactInput(poolD1, CANONICAL_USDC_MINT, 50000000n);
      expect(quoteCrossing).not.toBeNull();
      expect(quoteCrossing!.outAmount).toBe(611075812n);
      expect(quoteCrossing!.feeAmount).toBe(20001n);
      expect(quoteCrossing!.priceImpactBps).toBe(30);

      // Prove tick crossing via validated SDK state transition:
      // Crossing tick -25040 transitions pool liquidity from 50B to 75B (+25B liquidityNet)
      const quoteCrossingEmpty = adapter.quoteExactInput(poolD1Empty1, CANONICAL_USDC_MINT, 50000000n);
      expect(quoteCrossingEmpty!.outAmount).toBe(610820476n);
      // Validated SDK state transition delta:
      const crossingDelta = quoteCrossing!.outAmount - quoteCrossingEmpty!.outAmount;
      expect(crossingDelta).toBe(255336n); // Proven +255,336 lamports output gain from crossed tick

      // 3. Multi-array boundary crossing probe: $150 USDC -> crosses into array -24992 and crosses tick -24960
      const quoteMultiArray = adapter.quoteExactInput(poolD1, CANONICAL_USDC_MINT, 150000000n);
      expect(quoteMultiArray).not.toBeNull();
      expect(quoteMultiArray!.outAmount).toBe(1824778825n);
      expect(quoteMultiArray!.feeAmount).toBe(60001n);
      expect(quoteMultiArray!.priceImpactBps).toBe(76);

      // Prove multi-array crossing via counterfactual empty second array:
      const poolD1EmptyArr2: PoolState = {
        ...poolD1,
        extraData: {
          ...poolD1.extraData,
          tickArrays: { [-25344]: arrayMinus25344_d1, [-24992]: arrayMinus24992_d1_empty, [-24640]: arrayMinus24640_d1 }
        }
      };
      const quoteMultiEmpty = adapter.quoteExactInput(poolD1EmptyArr2, CANONICAL_USDC_MINT, 150000000n);
      expect(quoteMultiEmpty!.outAmount).toBe(1824507267n);
      const multiArrayDelta = quoteMultiArray!.outAmount - quoteMultiEmpty!.outAmount;
      expect(multiArrayDelta).toBe(271558n); // Proven +271,558 lamports output gain from crossed tick in array -24992
    });

    it('asserts actual tick crossings and exact pinned outputs in Direction 2 (WSOL -> USDC)', () => {
      // Starting tick: -25068
      // Next lower initialized tick: -25088 (offset 20 ticks down, requires ~0.175 SOL at L=50B)

      // 1. Sub-crossing probe: 0.05 SOL (50,000,000 lamports < 175M lamports) -> 0 ticks crossed
      const quoteSubCrossing = adapter.quoteExactInput(poolD2, CANONICAL_WSOL_MINT, 50000000n);
      expect(quoteSubCrossing).not.toBeNull();
      expect(quoteSubCrossing!.outAmount).toBe(4074152n);
      expect(quoteSubCrossing!.feeAmount).toBe(20000n);
      expect(quoteSubCrossing!.priceImpactBps).toBe(2);

      // Prove no tick was crossed: identical output to counterfactual empty array
      const poolD2Empty1: PoolState = {
        ...poolD2,
        extraData: {
          ...poolD2.extraData,
          tickArrays: { [-25344]: arrayMinus25344_d2_empty, [-25696]: arrayMinus25696_d2_empty, [-26048]: arrayMinus26048_d2 }
        }
      };
      const quoteSubEmpty = adapter.quoteExactInput(poolD2Empty1, CANONICAL_WSOL_MINT, 50000000n);
      expect(quoteSubEmpty!.outAmount).toBe(4074152n);
      expect(quoteSubCrossing!.outAmount).toBe(quoteSubEmpty!.outAmount);

      // 2. Real tick-crossing probe: 0.5 SOL (500,000,000 lamports > 175M lamports) -> MUST CROSS tick -25088
      const quoteCrossing = adapter.quoteExactInput(poolD2, CANONICAL_WSOL_MINT, 500000000n);
      expect(quoteCrossing).not.toBeNull();
      expect(quoteCrossing!.outAmount).toBe(40653422n);
      expect(quoteCrossing!.feeAmount).toBe(200001n);
      expect(quoteCrossing!.priceImpactBps).toBe(24);

      // Prove tick crossing via validated SDK state transition:
      // Crossing tick -25088 transitions pool liquidity from 50B to 75B (subtracting -25B net)
      const quoteCrossingEmpty = adapter.quoteExactInput(poolD2Empty1, CANONICAL_WSOL_MINT, 500000000n);
      expect(quoteCrossingEmpty!.outAmount).toBe(40637165n);
      const crossingDelta = quoteCrossing!.outAmount - quoteCrossingEmpty!.outAmount;
      expect(crossingDelta).toBe(16257n); // Proven +16,257 atomic USDC output gain from crossed tick

      // 3. Multi-array boundary crossing probe: 5.0 SOL -> crosses into lower array -25696 and crosses tick -25400
      const quoteMultiArray = adapter.quoteExactInput(poolD2, CANONICAL_WSOL_MINT, 5000000000n);
      expect(quoteMultiArray).not.toBeNull();
      expect(quoteMultiArray!.outAmount).toBe(399697035n);
      expect(quoteMultiArray!.feeAmount).toBe(2000001n);
      expect(quoteMultiArray!.priceImpactBps).toBe(192);

      // Prove multi-array crossing via counterfactual empty lower array:
      const poolD2EmptyArr2: PoolState = {
        ...poolD2,
        extraData: {
          ...poolD2.extraData,
          tickArrays: { [-25344]: arrayMinus25344_d2, [-25696]: arrayMinus25696_d2_empty, [-26048]: arrayMinus26048_d2 }
        }
      };
      const quoteMultiEmpty = adapter.quoteExactInput(poolD2EmptyArr2, CANONICAL_WSOL_MINT, 5000000000n);
      expect(quoteMultiEmpty!.outAmount).toBe(399662097n);
      const multiArrayDelta = quoteMultiArray!.outAmount - quoteMultiEmpty!.outAmount;
      expect(multiArrayDelta).toBe(34938n); // Proven +34,938 atomic USDC output gain from crossed tick in array -25696
    });
  });
});
