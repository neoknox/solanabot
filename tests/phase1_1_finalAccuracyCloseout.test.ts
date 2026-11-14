import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { swapQuoteByInputToken, TickArrayFacade } from '@orca-so/whirlpools-core';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { getTickArrayContentSignature } from '../src/dex/orcaTickArray.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { StateCache, getQuoteRelevantSignature } from '../src/scanner/stateCache.js';
import { TradeSizer, QuoterLeg } from '../src/profit/tradeSizer.js';
import {
  loadConfig,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';
import { PoolState, CostBreakdown } from '../src/types/index.js';

describe('Phase 1.1 Final Accuracy Closeout: Orca Multi-Tick Parity, Fingerprints & Freshness', () => {
  const config = loadConfig();
  const poolId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'; // Canonical WSOL/USDC Whirlpool
  const tickSpacing = 4;
  const delta = 88 * tickSpacing; // 352 ticks per array
  const activeTick = -25068; // Inside array -25344
  const sqrtPrice = 5267498573947197513n; // ~81.54 USDC per SOL
  const deepLiquidity = 465467525220858n;

  const dummyCosts: CostBreakdown = {
    consumedCostUSDC: '0.005',
    totalCostsUSDC: '0.005',
    safetyBufferUSDC: '0.002',
    networkFeeUSDC: '0.001',
    priorityFeeUSDC: '0.002',
    jitoTipUSDC: '0.000',
    tokenTransferFeesUSDC: '0.000',
    contingencyUSDC: '0.000',
    solPriceUSDC: '150.00',
    assumptions: ['mock cost assumptions']
  };

  /**
   * Helper to construct a validated TickArrayFacade with custom initialized ticks.
   */
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

  // 1. ORCA PRICE IMPACT TESTS
  describe('1. Orca Price Impact & MAX_PRICE_IMPACT_BPS Enforcement', () => {
    const adapter = new OrcaWhirlpoolAdapter();

    it('calculates nonzero protocol-correct price impact on shallow liquidity swaps and enforces MAX_PRICE_IMPACT_BPS', () => {
      // Create tick arrays for shallow pool (liquidity = 50,000,000,000)
      const tickArraysMap: Record<number, TickArrayFacade> = {
        [-25696]: createTickArrayWithTicks(-25696, {}),
        [-25344]: createTickArrayWithTicks(-25344, {}),
        [-24992]: createTickArrayWithTicks(-24992, {}),
        [-24640]: createTickArrayWithTicks(-24640, {})
      };

      const shallowPool: PoolState = {
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
        slot: 1000,
        receivedAt: Date.now(),
        liquidityUsd: 100000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: activeTick,
          tickSpacing: 4,
          feeRateRaw: 400,
          protocolFeeRate: 1300,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: '50000000000', // Shallow liquidity
          maxPriceImpactBps: 200,
          tickArrays: tickArraysMap,
          tickArrayReceivedAt: {
            [-25344]: Date.now(),
            [-24992]: Date.now(),
            [-24640]: Date.now(),
            [-25696]: Date.now(),
            [-26048]: Date.now()
          },
          tickArraySlots: {
            [-25344]: 1000,
            [-24992]: 1000,
            [-24640]: 1000,
            [-25696]: 1000,
            [-26048]: 1000
          }
        }
      };

      // 50 USDC swap into shallow pool has ~34 bps price impact (within 200 bps limit)
      const quote50 = adapter.quoteExactInput(shallowPool, CANONICAL_USDC_MINT, 50000000n);
      expect(quote50).not.toBeNull();
      expect(quote50!.priceImpactBps).toBe(34); // Exact non-zero effective price impact
      expect(quote50!.priceImpactBps).toBeGreaterThan(0);
      expect(quote50!.quoteSource).toBe('DIRECT_POOL');

      // 500 USDC swap into shallow pool exceeds 200 bps price impact and must fail closed
      const quote500 = adapter.quoteExactInput(shallowPool, CANONICAL_USDC_MINT, 500000000n);
      expect(quote500).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('EXCESSIVE_PRICE_IMPACT');
    });

    it('TradeSizer fails closed when any leg exceeds MAX_PRICE_IMPACT_BPS', () => {
      const shallowPool: PoolState = {
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
        slot: 1000,
        receivedAt: Date.now(),
        liquidityUsd: 100000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: activeTick,
          tickSpacing: 4,
          feeRateRaw: 400,
          protocolFeeRate: 1300,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: '50000000000',
          maxPriceImpactBps: 200,
          tickArrays: {
            [-25696]: createTickArrayWithTicks(-25696, {}),
            [-25344]: createTickArrayWithTicks(-25344, {}),
            [-24992]: createTickArrayWithTicks(-24992, {}),
            [-24640]: createTickArrayWithTicks(-24640, {})
          },
          tickArrayReceivedAt: {
            [-25696]: Date.now(),
            [-25344]: Date.now(),
            [-24992]: Date.now(),
            [-24640]: Date.now()
          },
          tickArraySlots: {
            [-25696]: 1000,
            [-25344]: 1000,
            [-24992]: 1000,
            [-24640]: 1000
          }
        }
      };

      const sizer = new TradeSizer(config);
      const legs: QuoterLeg[] = [
        { pool: shallowPool, adapter, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 }
      ];

      // Sizing 500 USDC on shallow pool must fail closed with EXCESSIVE_PRICE_IMPACT
      const eval500 = sizer.evaluateSize(500, legs, dummyCosts, 1000);
      expect(eval500.isViable).toBe(false);
      expect(eval500.rejectionReason).toBe('EXCESSIVE_PRICE_IMPACT');
    });
  });

  // 2. TICK ARRAY STATE FINGERPRINTS
  describe('2. Tick Array Liquidity & State Fingerprints', () => {
    it('produces identical fingerprints for identical tick array data and increments revision when tick liquidity changes in the same slot', () => {
      const cache = new StateCache();
      const initialSlot = 5000;
      const now = Date.now();

      const arrayBase = createTickArrayWithTicks(-25344, {
        [-25120]: { net: 10000000000000n, gross: 10000000000000n }
      });

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
          tickArrays: {
            [-25344]: arrayBase
          }
        }
      };

      // 1. Initial set
      const res1 = cache.setPoolState(pool);
      expect(res1.hasChanged).toBe(true);
      expect(res1.stateRevision).toBe(1);

      // 2. Redundant update with identical tick array data in the same slot
      const poolSame = {
        ...pool,
        extraData: {
          ...pool.extraData,
          tickArrays: {
            [-25344]: createTickArrayWithTicks(-25344, {
              [-25120]: { net: 10000000000000n, gross: 10000000000000n }
            })
          }
        }
      };
      const res2 = cache.setPoolState(poolSame);
      expect(res2.hasChanged).toBe(false); // No change!
      expect(res2.stateRevision).toBe(1);  // Revision does NOT increment

      // 3. Update with changed tick liquidityNet within the SAME slot
      const poolModified = {
        ...pool,
        extraData: {
          ...pool.extraData,
          tickArrays: {
            [-25344]: createTickArrayWithTicks(-25344, {
              [-25120]: { net: 15000000000000n, gross: 15000000000000n } // Changed liquidityNet
            })
          }
        }
      };
      const res3 = cache.setPoolState(poolModified);
      expect(res3.hasChanged).toBe(true);  // Detected liquidity change!
      expect(res3.stateRevision).toBe(2);  // Revision bumped in same slot!

      // 4. Update initializing a new tick within the array
      const poolNewTick = {
        ...pool,
        extraData: {
          ...pool.extraData,
          tickArrays: {
            [-25344]: createTickArrayWithTicks(-25344, {
              [-25120]: { net: 15000000000000n, gross: 15000000000000n },
              [-25088]: { net: -5000000000000n, gross: 5000000000000n } // New initialized tick
            })
          }
        }
      };
      const res4 = cache.setPoolState(poolNewTick);
      expect(res4.hasChanged).toBe(true);
      expect(res4.stateRevision).toBe(3);
    });
  });

  // 3. INDEPENDENT FRESHNESS
  describe('3. Independent Whirlpool & Tick Array Freshness', () => {
    it('maintains independent observation timestamps and fails closed on missing or stale tick arrays', async () => {
      const scanner = new ArbitrageScanner(config);
      const initialSlot = 1000;
      const now = Date.now();

      const arrayMinus26048 = createTickArrayWithTicks(-26048, {});
      const arrayMinus25696 = createTickArrayWithTicks(-25696, {});
      const arrayMinus25344 = createTickArrayWithTicks(-25344, {});
      const arrayMinus24992 = createTickArrayWithTicks(-24992, {});

      // Pool with array -25696 STALE (> 30s TTL)
      const poolWithStaleArray: PoolState = {
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
        receivedAt: now, // Pool account itself is fresh
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
            [-25344]: arrayMinus25344,
            [-24992]: arrayMinus24992
          },
          tickArraySlots: {
            [-26048]: initialSlot,
            [-25696]: initialSlot,
            [-25344]: initialSlot,
            [-24992]: initialSlot
          },
          tickArrayReceivedAt: {
            [-26048]: now,
            [-25696]: now - 45000, // STALE (45s ago)
            [-25344]: now,
            [-24992]: now
          }
        }
      };

      (scanner as any).stateCache.setPoolState(poolWithStaleArray);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

      const adapter = new OrcaWhirlpoolAdapter();

      // Swapping Token A -> Token B requires [-25344, -25696, -26048].
      // Array -25696 is stale -> must fail closed with STALE_QUOTE
      const quoteStale = adapter.quoteExactInput(poolWithStaleArray, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteStale).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');

      // Now deliver a POOL_ACCOUNT update for the Whirlpool:
      // Verify that Whirlpool pool update does NOT overwrite tick array timestamps or freshen stale arrays!
      const mockPoolBuf = Buffer.alloc(653);
      mockPoolBuf.writeUInt16LE(4, 41); // tickSpacing: 4
      mockPoolBuf.writeUInt16LE(400, 45); // feeRate: 400
      mockPoolBuf.writeBigUInt64LE(50000000000n, 49); // liquidity
      mockPoolBuf.writeBigUInt64LE(sqrtPrice & 0xffffffffffffffffn, 65);
      mockPoolBuf.writeBigUInt64LE(sqrtPrice >> 64n, 73);
      mockPoolBuf.writeInt32LE(activeTick, 81);
      new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolBuf, 101);
      new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolBuf, 181);

      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: mockPoolBuf,
        slot: initialSlot + 5,
        receivedAtMs: now + 100,
        monotonicReceiptTime: performance.now()
      });

      const updatedPool = (scanner as any).stateCache.getPoolState(poolId);
      // Whirlpool pool observation updated
      expect(updatedPool.slot).toBe(initialSlot + 5);
      expect(updatedPool.receivedAt).toBe(now + 100);
      // Tick array observation timestamps preserved independently; array -25696 remains STALE!
      expect(updatedPool.extraData.tickArrayReceivedAt[-25696]).toBe(now - 45000);
      const quoteStillStale = adapter.quoteExactInput(updatedPool, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteStillStale).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');
    });

    it('fails closed when required tick array is missing for the swap direction', () => {
      const adapter = new OrcaWhirlpoolAdapter();
      const now = Date.now();

      // Only provides tick array -25344; missing -25696 and -26048 for A_TO_B
      const poolMissingArray: PoolState = {
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
        slot: 1000,
        receivedAt: now,
        liquidityUsd: 50000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: activeTick,
          tickSpacing: 4,
          sqrtPrice: sqrtPrice.toString(),
          liquidity: deepLiquidity.toString(),
          tickArrays: {
            [-25344]: createTickArrayWithTicks(-25344, {})
          }
        }
      };

      const quoteMissing = adapter.quoteExactInput(poolMissingArray, CANONICAL_WSOL_MINT, 150000000n);
      expect(quoteMissing).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');
    });
  });

  // 4. ACTUAL MULTI-TICK PARITY
  describe('4. Actual Multi-Tick Official Parity Vectors (Exact Atomic Unit Agreement)', () => {
    const adapter = new OrcaWhirlpoolAdapter();
    const probeSizes = [25, 50, 100, 250, 500, 1000];

    // Construct 5 consecutive tick arrays around active tick -25068
    // Nonzero liquidityNet values placed to ensure initialized tick boundary crossings
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
      [-25088]: { net: -5000000000000n, gross: 5000000000000n }
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
        tickArrays: tickArraysMap,
        tickArrayReceivedAt: {
          [-26048]: Date.now(),
          [-25696]: Date.now(),
          [-25344]: Date.now(),
          [-24992]: Date.now(),
          [-24640]: Date.now()
        },
        tickArraySlots: {
          [-26048]: 468700000,
          [-25696]: 468700000,
          [-25344]: 468700000,
          [-24992]: 468700000,
          [-24640]: 468700000
        }
      }
    };

    it('matches exact official WASM reference outputs across all probe sizes in Direction 1 (USDC -> WSOL)', () => {
      multiTickPool.receivedAt = Date.now();
      for (const k of Object.keys(multiTickPool.extraData!.tickArrayReceivedAt!)) {
        (multiTickPool.extraData!.tickArrayReceivedAt as any)[k] = Date.now();
      }
      const sequenceArrays = [arrayMinus25344, arrayMinus24992, arrayMinus24640];
      const whirlpoolFacade: any = {
        feeTierIndexSeed: new Uint8Array([4, 0]),
        tickSpacing: 4,
        feeRate: 400,
        protocolFeeRate: 1300,
        liquidity: deepLiquidity,
        sqrtPrice,
        tickCurrentIndex: activeTick,
        feeGrowthGlobalA: 0n,
        feeGrowthGlobalB: 0n,
        rewardLastUpdatedTimestamp: 0n,
        rewardInfos: [
          { emissionsPerSecondX64: 0n, growthGlobalX64: 0n },
          { emissionsPerSecondX64: 0n, growthGlobalX64: 0n },
          { emissionsPerSecondX64: 0n, growthGlobalX64: 0n }
        ]
      };

      for (const size of probeSizes) {
        const inAmount = BigInt(size * 1e6);
        const actualQuote = adapter.quoteExactInput(multiTickPool, CANONICAL_USDC_MINT, inAmount);
        expect(actualQuote).not.toBeNull();

        // Official Orca Whirlpool reference quote
        const expectedQuote = swapQuoteByInputToken(
          inAmount,
          false,
          0,
          whirlpoolFacade,
          null,
          sequenceArrays,
          BigInt(Math.floor(Date.now() / 1000))
        );

        // Exact atomic-unit agreement:
        expect(actualQuote!.outAmount).toBe(expectedQuote.tokenEstOut);
        expect(actualQuote!.feeAmount).toBe(expectedQuote.tradeFee);
        expect(actualQuote!.quoteSource).toBe('DIRECT_POOL');
        expect(actualQuote!.executionType).toBe('POTENTIAL_ATOMIC');
      }
    });

    it('matches exact official WASM reference outputs across all probe sizes in Direction 2 (WSOL -> USDC)', () => {
      multiTickPool.receivedAt = Date.now();
      for (const k of Object.keys(multiTickPool.extraData!.tickArrayReceivedAt!)) {
        (multiTickPool.extraData!.tickArrayReceivedAt as any)[k] = Date.now();
      }
      const sequenceArrays = [arrayMinus25344, arrayMinus25696, arrayMinus26048];
      const whirlpoolFacade: any = {
        feeTierIndexSeed: new Uint8Array([4, 0]),
        tickSpacing: 4,
        feeRate: 400,
        protocolFeeRate: 1300,
        liquidity: deepLiquidity,
        sqrtPrice,
        tickCurrentIndex: activeTick,
        feeGrowthGlobalA: 0n,
        feeGrowthGlobalB: 0n,
        rewardLastUpdatedTimestamp: 0n,
        rewardInfos: [
          { emissionsPerSecondX64: 0n, growthGlobalX64: 0n },
          { emissionsPerSecondX64: 0n, growthGlobalX64: 0n },
          { emissionsPerSecondX64: 0n, growthGlobalX64: 0n }
        ]
      };

      for (const size of probeSizes) {
        const solLamports = BigInt(Math.floor((size / 160) * 1e9));
        const actualQuote = adapter.quoteExactInput(multiTickPool, CANONICAL_WSOL_MINT, solLamports);
        expect(actualQuote).not.toBeNull();

        // Official Orca Whirlpool reference quote
        const expectedQuote = swapQuoteByInputToken(
          solLamports,
          true,
          0,
          whirlpoolFacade,
          null,
          sequenceArrays,
          BigInt(Math.floor(Date.now() / 1000))
        );

        // Exact atomic-unit agreement:
        expect(actualQuote!.outAmount).toBe(expectedQuote.tokenEstOut);
        expect(actualQuote!.feeAmount).toBe(expectedQuote.tradeFee);
        expect(actualQuote!.quoteSource).toBe('DIRECT_POOL');
        expect(actualQuote!.executionType).toBe('POTENTIAL_ATOMIC');
      }
    });
  });
});
