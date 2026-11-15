import { describe, it, expect, vi } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { loadConfig } from '../src/config/index.js';
import {
  tickIndexToSqrtPrice,
  tryGetAmountDeltaA,
  tryGetAmountDeltaB,
  tryGetNextSqrtPriceFromA,
  tryGetNextSqrtPriceFromB
} from '@orca-so/whirlpools-core';
import { RaydiumClmmAdapter } from '../src/dex/raydiumClmmAdapter.js';
import {
  RaydiumClmmAmmConfig,
  decodeRaydiumClmmAmmConfig,
  RAYDIUM_CLMM_AMM_CONFIG_SIZE,
  RAYDIUM_CLMM_AMM_CONFIG_DISCRIMINATOR
} from '../src/dex/raydiumClmmAmmConfig.js';
import {
  deriveRaydiumClmmTickArrayPda,
  getRaydiumClmmArrayStartIndex,
  getRequiredRaydiumClmmTickArrayStartIndices,
  getSurroundingRaydiumClmmTickArrayStartIndices,
  getBidirectionalRaydiumClmmTickArrayStartIndices,
  decodeRaydiumClmmTickArray,
  RaydiumClmmTickArray,
  RAYDIUM_CLMM_TICK_ARRAY_SIZE,
  RAYDIUM_CLMM_TICK_STATE_SIZE,
  RAYDIUM_CLMM_TICK_ARRAY_ACCOUNT_SIZE
} from '../src/dex/raydiumClmmTickArray.js';
import {
  CANONICAL_USDC_MINT,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';
import { PoolState } from '../src/types/index.js';

describe('Raydium CLMM Pricing Adapter & Protocol Parity Suite', () => {
  const adapter = new RaydiumClmmAdapter();
  const testPoolId = '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj';

  /**
   * Helper to construct a mock 1544-byte Raydium CLMM PoolState binary buffer.
   */
  function createMockPoolStateBuffer(params: {
    mint0?: string;
    mint1?: string;
    vault0?: string;
    vault1?: string;
    ammConfig?: string;
    tickSpacing?: number;
    liquidity?: bigint;
    sqrtPriceX64?: bigint;
    tickCurrent?: number;
  }): Buffer {
    const buf = Buffer.alloc(1544);
    // Discriminator (8 bytes)
    Buffer.from('f72c050a98b47932', 'hex').copy(buf, 0);
    // bump at 8
    buf.writeUInt8(254, 8);
    // amm_config at 9..41
    new PublicKey(params.ammConfig || '9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x').toBuffer().copy(buf, 9);
    // owner at 41..73
    new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM).toBuffer().copy(buf, 41);
    // token_mint_0 at 73..105
    new PublicKey(params.mint0 || CANONICAL_WSOL_MINT).toBuffer().copy(buf, 73);
    // token_mint_1 at 105..137
    new PublicKey(params.mint1 || CANONICAL_USDC_MINT).toBuffer().copy(buf, 105);
    // token_vault_0 at 137..169
    new PublicKey(params.vault0 || '6P4tvbzRY6Bh3MiWDHuLqyHywovsRwRpfskPvyeSoHsz').toBuffer().copy(buf, 137);
    // token_vault_1 at 169..201
    new PublicKey(params.vault1 || '6mK4Pxs6GhwnessH7CvPivqDYauiHZmAdbEFDpXFk9zt').toBuffer().copy(buf, 169);
    // observation_key at 201..233
    new PublicKey('11111111111111111111111111111111').toBuffer().copy(buf, 201);
    // mint_decimals_0 at 233
    buf.writeUInt8(9, 233);
    // mint_decimals_1 at 234
    buf.writeUInt8(6, 234);
    // tick_spacing at 235..237
    buf.writeUInt16LE(params.tickSpacing ?? 1, 235);
    // liquidity at 237..253 (u128 LE)
    const liq = params.liquidity ?? 567954298646n;
    buf.writeBigUInt64LE(liq & 0xffffffffffffffffn, 237);
    buf.writeBigUInt64LE(liq >> 64n, 245);
    // sqrt_price_x64 at 253..269 (u128 LE)
    const sqrt = params.sqrtPriceX64 ?? 4990017269699282904n;
    buf.writeBigUInt64LE(sqrt & 0xffffffffffffffffn, 253);
    buf.writeBigUInt64LE(sqrt >> 64n, 261);
    // tick_current at 269..273 (i32 LE)
    buf.writeInt32LE(params.tickCurrent ?? -26151, 269);
    return buf;
  }

  /**
   * Helper to construct a mock 117-byte Raydium CLMM AmmConfig binary buffer.
   */
  function createMockAmmConfigBuffer(params: {
    tradeFeeRate?: number;
    tickSpacing?: number;
    protocolFeeRate?: number;
    fundFeeRate?: number;
    index?: number;
    discriminator?: string;
    ownerPubkey?: string;
  }): Buffer {
    const buf = Buffer.alloc(RAYDIUM_CLMM_AMM_CONFIG_SIZE);
    Buffer.from(params.discriminator ?? RAYDIUM_CLMM_AMM_CONFIG_DISCRIMINATOR, 'hex').copy(buf, 0);
    buf.writeUInt8(255, 8); // bump
    buf.writeUInt16LE(params.index ?? 6, 9);
    new PublicKey(params.ownerPubkey ?? KNOWN_PROGRAM_IDS.RAYDIUM_CLMM).toBuffer().copy(buf, 11);
    buf.writeUInt32LE(params.protocolFeeRate ?? 120000, 43);
    buf.writeUInt32LE(params.tradeFeeRate ?? 200, 47);
    buf.writeUInt16LE(params.tickSpacing ?? 1, 51);
    buf.writeUInt32LE(params.fundFeeRate ?? 40000, 53);
    new PublicKey('11111111111111111111111111111111').toBuffer().copy(buf, 57);
    return buf;
  }

  /**
   * Helper to construct a mock 10240-byte Raydium CLMM TickArrayState buffer.
   */
  function createMockTickArrayBuffer(
    poolId: string,
    startTickIndex: number,
    tickSpacing: number,
    initializedTicks: Array<{ tick: number; liquidityNet: bigint; liquidityGross: bigint }>
  ): Buffer {
    const buf = Buffer.alloc(RAYDIUM_CLMM_TICK_ARRAY_ACCOUNT_SIZE);
    // Discriminator (8 bytes)
    Buffer.from('c09b55cd31f9812a', 'hex').copy(buf, 0);
    // pool_id at 8..40
    new PublicKey(poolId).toBuffer().copy(buf, 8);
    // start_tick_index at 40..44 (i32 LE)
    buf.writeInt32LE(startTickIndex, 40);

    let offset = 44;
    const initMap = new Map(initializedTicks.map(t => [t.tick, t]));

    for (let i = 0; i < RAYDIUM_CLMM_TICK_ARRAY_SIZE; i++) {
      const tick = startTickIndex + i * tickSpacing;
      buf.writeInt32LE(tick, offset);

      const initData = initMap.get(tick);
      if (initData) {
        // liquidity_net (i128 signed LE)
        const netLow = initData.liquidityNet & 0xffffffffffffffffn;
        const netHigh = initData.liquidityNet >> 64n;
        buf.writeBigUInt64LE(netLow, offset + 4);
        buf.writeBigInt64LE(netHigh, offset + 12);

        // liquidity_gross (u128 unsigned LE)
        const grossLow = initData.liquidityGross & 0xffffffffffffffffn;
        const grossHigh = initData.liquidityGross >> 64n;
        buf.writeBigUInt64LE(grossLow, offset + 20);
        buf.writeBigUInt64LE(grossHigh, offset + 28);
      }

      offset += RAYDIUM_CLMM_TICK_STATE_SIZE;
    }

    buf.writeUInt8(initializedTicks.length, 10124);
    return buf;
  }

  describe('1. Binary Layout & On-Chain Account Decoding', () => {
    it('Decodes a valid 1544-byte Raydium CLMM PoolState binary buffer exactly', () => {
      const raw = createMockPoolStateBuffer({
        tickSpacing: 10,
        liquidity: 1000000000000n,
        sqrtPriceX64: 4990017269699282904n,
        tickCurrent: -26150
      });

      const decoded = adapter.decodePoolState(raw, testPoolId, 250000000);
      expect(decoded).not.toBeNull();
      expect(decoded?.id).toBe(testPoolId);
      expect(decoded?.dex).toBe('RAYDIUM_CLMM');
      expect(decoded?.tokenAMint).toBe(CANONICAL_WSOL_MINT);
      expect(decoded?.tokenBMint).toBe(CANONICAL_USDC_MINT);

      const extra = decoded?.extraData as any;
      expect(extra.tickSpacing).toBe(10);
      expect(extra.tickCurrent).toBe(-26150);
      expect(extra.liquidity).toBe('1000000000000');
      expect(extra.sqrtPrice).toBe('4990017269699282904');
      expect(extra.mintDecimalsA).toBe(9);
      expect(extra.mintDecimalsB).toBe(6);
      expect(extra.ammConfig).toBe('9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x');
    });

    it('Fails closed on buffer smaller than 1544 bytes', () => {
      const shortBuf = Buffer.alloc(1500);
      const decoded = adapter.decodePoolState(shortBuf, testPoolId, 250000000);
      expect(decoded).toBeNull();
    });

    it('Fails closed on non-allowlisted mints', () => {
      const badMintBuf = createMockPoolStateBuffer({
        mint0: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
      });
      const decoded = adapter.decodePoolState(badMintBuf, testPoolId, 250000000);
      expect(decoded).toBeNull();
    });

    it('Fails closed on zero on-chain liquidity or zero sqrtPrice', () => {
      const zeroLiq = createMockPoolStateBuffer({ liquidity: 0n });
      expect(adapter.decodePoolState(zeroLiq, testPoolId, 250000000)).toBeNull();

      const zeroSqrt = createMockPoolStateBuffer({ sqrtPriceX64: 0n });
      expect(adapter.decodePoolState(zeroSqrt, testPoolId, 250000000)).toBeNull();
    });
  });

  describe('2. On-Chain AmmConfig Layout & Validation', () => {
    it('Decodes a valid 117-byte Raydium CLMM AmmConfig buffer', () => {
      const rawConfig = createMockAmmConfigBuffer({
        tradeFeeRate: 200, // 2 bps
        tickSpacing: 1,
        index: 6
      });

      const config = decodeRaydiumClmmAmmConfig(rawConfig, 'EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR', 250000000);
      expect(config).not.toBeNull();
      expect(config?.id).toBe('EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR');
      expect(config?.tradeFeeRate).toBe(200);
      expect(config?.tickSpacing).toBe(1);
      expect(config?.index).toBe(6);
      expect(config?.protocolFeeRate).toBe(120000);
    });

    it('Fails closed on AmmConfig buffer smaller than 117 bytes', () => {
      const shortBuf = Buffer.alloc(100);
      const config = decodeRaydiumClmmAmmConfig(shortBuf, 'config_id', 250000000);
      expect(config).toBeNull();
    });

    it('Fails closed on invalid AmmConfig discriminator', () => {
      const badDiscBuf = createMockAmmConfigBuffer({ discriminator: '0000000000000000' });
      const config = decodeRaydiumClmmAmmConfig(badDiscBuf, 'config_id', 250000000);
      expect(config).toBeNull();
    });

    it('Fails closed on owner mismatch when verifying program ownership', () => {
      const rawConfig = createMockAmmConfigBuffer({});
      const config = decodeRaydiumClmmAmmConfig(
        rawConfig,
        'config_id',
        250000000,
        Date.now(),
        'WrongProgram1111111111111111111111111111111'
      );
      expect(config).toBeNull();
    });

    it('Fails closed on excessive tradeFeeRate (> 1,000,000)', () => {
      const badFeeBuf = createMockAmmConfigBuffer({ tradeFeeRate: 1000001 });
      const config = decodeRaydiumClmmAmmConfig(badFeeBuf, 'config_id', 250000000);
      expect(config).toBeNull();
    });
  });

  describe('3. Tick Array PDA Derivation & Layout Decoding', () => {
    it('Derives exact PDA matching program ID and seed formula [tick_array, pool_id, start_tick.toBE(4)]', () => {
      const pda = deriveRaydiumClmmTickArrayPda(testPoolId, -26160);
      expect(pda).toBeInstanceOf(PublicKey);
      expect(pda.toBase58()).toBe('DhzLeDuEfWAmBCrHNiChMcMGgER5vLcdoqPHVkuS9aE1');
    });

    it('Calculates correct start tick indices, directional 3-array sequence, and bidirectional 5-array sequence', () => {
      const tickCurrent = -26151;
      const tickSpacing = 1;

      expect(getRaydiumClmmArrayStartIndex(tickCurrent, tickSpacing)).toBe(-26160);

      // A_TO_B (zeroForOne: price drops, tick moves down)
      const aToBIndices = getRequiredRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing, 'A_TO_B');
      expect(aToBIndices).toEqual([-26160, -26220, -26280]);

      // B_TO_A (oneForZero: price rises, tick moves up)
      const bToAIndices = getRequiredRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing, 'B_TO_A');
      expect(bToAIndices).toEqual([-26160, -26100, -26040]);

      // Bidirectional 5-array sequence resolving arrays needed for BOTH swap directions
      const bidirectional = getBidirectionalRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing);
      expect(bidirectional).toEqual([-26280, -26220, -26160, -26100, -26040]);
    });

    it('Decodes 10,240-byte TickArray account buffer with initialized ticks and signed liquidityNet', () => {
      const rawArray = createMockTickArrayBuffer(testPoolId, -26220, 1, [
        { tick: -26174, liquidityNet: 20563271491n, liquidityGross: 59815091953n }
      ]);

      const decoded = decodeRaydiumClmmTickArray(rawArray, testPoolId);
      expect(decoded).not.toBeNull();
      expect(decoded?.poolId).toBe(testPoolId);
      expect(decoded?.startTickIndex).toBe(-26220);
      expect(decoded?.initializedTickCount).toBe(1);
      expect(decoded?.ticks.length).toBe(60);

      const targetTick = decoded?.ticks.find(t => t.tick === -26174);
      expect(targetTick).toBeDefined();
      expect(targetTick?.initialized).toBe(true);
      expect(targetTick?.liquidityGross).toBe(59815091953n);
      expect(targetTick?.liquidityNet).toBe(20563271491n);
    });
  });

  describe('4. Contract-Equivalent Reference Math & Multi-Tier Fee Parity', () => {
    function setupTestPool(feePpm: number = 2500): {
      pool: PoolState;
      tickArrays: Record<number, RaydiumClmmTickArray>;
    } {
      const tickCurrent = -26151;
      const tickSpacing = 1;

      // Setup 5 arrays: [-26280, -26220, -26160, -26100, -26040]
      const arr1 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26160, tickSpacing, [
        { tick: -26155, liquidityNet: 10000000000n, liquidityGross: 20000000000n }
      ]), testPoolId)!;

      const arr2 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26220, tickSpacing, [
        { tick: -26174, liquidityNet: 20563271491n, liquidityGross: 59815091953n }
      ]), testPoolId)!;

      const arr3 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26280, tickSpacing, []), testPoolId)!;
      const arrUp1 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26100, tickSpacing, [
        { tick: -26080, liquidityNet: 15000000000n, liquidityGross: 30000000000n }
      ]), testPoolId)!;
      const arrUp2 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26040, tickSpacing, []), testPoolId)!;

      const tickArrays: Record<number, RaydiumClmmTickArray> = {
        [-26160]: arr1,
        [-26220]: arr2,
        [-26280]: arr3,
        [-26100]: arrUp1,
        [-26040]: arrUp2
      };

      const now = Date.now();
      const tickArrayReceivedAt: Record<number, number> = {
        [-26160]: now,
        [-26220]: now,
        [-26280]: now,
        [-26100]: now,
        [-26040]: now
      };
      const tickArraySlots: Record<number, number> = {
        [-26160]: 250000000,
        [-26220]: 250000000,
        [-26280]: 250000000,
        [-26100]: 250000000,
        [-26040]: 250000000
      };

      const pool: PoolState = {
        id: testPoolId,
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000000000000n,
        reserveB: 73000000000000n,
        feeBps: Math.round(feePpm / 100),
        slot: 250000000,
        receivedAt: now,
        liquidityUsd: 4000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent,
          tickSpacing,
          liquidity: '567954298646',
          sqrtPrice: '4990017269699282904',
          tradeFeeRate: feePpm,
          feeRate: feePpm,
          tickArrays,
          tickArrayReceivedAt,
          tickArraySlots
        }
      };

      return { pool, tickArrays };
    }

    /**
     * Pure contract-equivalent reference implementation for single-step swap computation.
     */
    function referenceComputeStep(
      currentSqrtPrice: bigint,
      targetSqrtPrice: bigint,
      liquidity: bigint,
      amountRemaining: bigint,
      feeRatePpm: number,
      zeroForOne: boolean
    ) {
      const feeRateBig = BigInt(feeRatePpm);
      const DENOM = 1_000_000n;
      const amountForPriceCalc = (amountRemaining * (DENOM - feeRateBig)) / DENOM;

      const maxAmountIn = zeroForOne
        ? tryGetAmountDeltaA(targetSqrtPrice, currentSqrtPrice, liquidity, true)
        : tryGetAmountDeltaB(currentSqrtPrice, targetSqrtPrice, liquidity, true);

      if (amountForPriceCalc >= maxAmountIn && maxAmountIn > 0n) {
        const stepAmountOut = zeroForOne
          ? tryGetAmountDeltaB(targetSqrtPrice, currentSqrtPrice, liquidity, false)
          : tryGetAmountDeltaA(currentSqrtPrice, targetSqrtPrice, liquidity, false);
        const stepFee = (maxAmountIn * feeRateBig + (DENOM - feeRateBig - 1n)) / (DENOM - feeRateBig);

        return {
          nextSqrtPrice: targetSqrtPrice,
          stepAmountIn: maxAmountIn,
          stepAmountOut,
          stepFee,
          reachedTarget: true
        };
      } else {
        const nextSqrtPrice = zeroForOne
          ? tryGetNextSqrtPriceFromA(currentSqrtPrice, liquidity, amountForPriceCalc, true)
          : tryGetNextSqrtPriceFromB(currentSqrtPrice, liquidity, amountForPriceCalc, true);
        const stepAmountIn = amountForPriceCalc;
        const stepAmountOut = zeroForOne
          ? tryGetAmountDeltaB(nextSqrtPrice, currentSqrtPrice, liquidity, false)
          : tryGetAmountDeltaA(currentSqrtPrice, nextSqrtPrice, liquidity, false);
        const stepFee = amountRemaining > amountForPriceCalc ? amountRemaining - amountForPriceCalc : 0n;

        return {
          nextSqrtPrice,
          stepAmountIn,
          stepAmountOut,
          stepFee,
          reachedTarget: false
        };
      }
    }

    it('Compares single-tick small swap against contract-equivalent reference with 0 rounding difference', () => {
      const { pool } = setupTestPool(200); // 2 bps = 200 ppm
      const smallAmountIn = 100_000_000n; // 0.1 SOL (completes within tick -26151 before reaching -26155)

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, smallAmountIn);
      expect(quote).not.toBeNull();

      // Compute contract-equivalent reference
      const targetSqrtPrice = tickIndexToSqrtPrice(-26155);
      const ref = referenceComputeStep(
        4990017269699282904n,
        targetSqrtPrice,
        567954298646n,
        smallAmountIn,
        200,
        true
      );

      expect(ref.reachedTarget).toBe(false);
      // Expected fee: 100,000,000 * 200 / 1,000,000 = 20,000
      expect(ref.stepFee).toBe(20000n);
      expect(quote?.feeAmount).toBe(ref.stepFee);

      // Verify conservative output matches floor(ref.stepAmountOut * 9985 / 10000)
      const expectedConservative = (ref.stepAmountOut * 9985n) / 10000n;
      expect(quote?.outAmount).toBe(expectedConservative);

      // Rounding difference between reference and quote is exactly 0
      const roundingDiff = (quote?.outAmount ?? 0n) - expectedConservative;
      expect(roundingDiff).toBe(0n);
    });

    it('Tests all official real fee tiers (1, 2, 5, 25, 100 bps) and records fee parity', () => {
      const feeTiers = [
        { bps: 1, ppm: 100, expectedFee: 10000n },
        { bps: 2, ppm: 200, expectedFee: 20000n },
        { bps: 5, ppm: 500, expectedFee: 50000n },
        { bps: 25, ppm: 2500, expectedFee: 250000n },
        { bps: 100, ppm: 10000, expectedFee: 1000000n }
      ];

      const smallAmountIn = 100_000_000n; // 0.1 SOL

      for (const tier of feeTiers) {
        const { pool } = setupTestPool(tier.ppm);
        const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, smallAmountIn);

        expect(quote).not.toBeNull();
        expect(quote?.feeAmount).toBe(tier.expectedFee);
        expect((quote?.rawRouteInfo as any)?.effectiveFeePpm).toBe(tier.ppm);
      }
    });

    it('Supports zeroForOne (A -> B: SOL -> USDC) multi-tick traversal with exact integer step fees', () => {
      const { pool } = setupTestPool(100); // 1 bps = 100 ppm
      const amountIn = 1_000_000_000n; // 1 SOL (crosses tick -26155 into second step)
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, amountIn);

      expect(quote).not.toBeNull();
      expect(quote?.inputMint).toBe(CANONICAL_WSOL_MINT);
      expect(quote?.outputMint).toBe(CANONICAL_USDC_MINT);
      expect(quote?.inAmount).toBe(amountIn);

      // Multi-step fee across tick -26155:
      // Step 1 to tick -26155: maxIn = 495,779,429; fee1 = ceil(495,779,429 * 100 / 999,900) = 49,583
      // Step 2 remaining: 504,170,988; fee2 = 50,418
      // Total fee: 49,583 + 50,418 = 100,001 (1-unit integer ceiling difference recorded)
      expect(quote?.feeAmount).toBe(100001n);
      expect(Number(quote?.outAmount)).toBeGreaterThan(70_000_000);
      expect(Number(quote?.outAmount)).toBeLessThan(75_000_000);
      expect(quote?.priceImpactBps).toBeLessThan(10);
    });

    it('Supports oneForZero (B -> A: USDC -> SOL) with exact integer math', () => {
      const { pool } = setupTestPool(100); // 1 bps = 100 ppm
      const amountIn = 100_000_000n; // 100 USDC
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, amountIn);

      expect(quote).not.toBeNull();
      expect(quote?.inputMint).toBe(CANONICAL_USDC_MINT);
      expect(quote?.outputMint).toBe(CANONICAL_WSOL_MINT);
      expect(quote?.inAmount).toBe(amountIn);
      expect(quote?.feeAmount).toBe(10000n); // 100,000,000 * 100 / 1,000,000 = 10,000

      // 100 USDC yields ~1.36 SOL = ~1,365,000,000 lamports
      expect(Number(quote?.outAmount)).toBeGreaterThan(1_300_000_000);
      expect(Number(quote?.outAmount)).toBeLessThan(1_400_000_000);
    });

    it('Traverses negative liquidityNet tick crossing and adjusts active liquidity correctly', () => {
      const { pool, tickArrays } = setupTestPool(100);

      // Create a tick with negative liquidityNet: -10B
      // Swapping zeroForOne (price falling) subtracts liquidityNet: L - (-10B) = L + 10B
      tickArrays[-26160].ticks = tickArrays[-26160].ticks.map(t =>
        t.tick === -26155 ? { ...t, liquidityNet: -10000000000n, liquidityGross: 10000000000n, initialized: true } : t
      );

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n);
      expect(quote).not.toBeNull();
      // Liquidity increased after crossing -> higher output than base pool
      expect(Number(quote?.outAmount)).toBeGreaterThan(70_000_000);
    });

    it('Traverses large swaps crossing multiple initialized ticks across tick arrays', () => {
      const { pool } = setupTestPool(100);
      // Large swap: 10 SOL pushes price across initialized tick -26155 and -26174
      const amountIn = 10_000_000_000n;
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, amountIn);

      expect(quote).not.toBeNull();
      expect(quote?.inAmount).toBe(amountIn);
      expect(Number(quote?.outAmount)).toBeGreaterThan(700_000_000);
    });
  });

  describe('5. Tick-Array Hydration Boundaries & Strict Freshness Gates', () => {
    function setupTestPool(feePpm: number = 2500): PoolState {
      const tickCurrent = -26151;
      const tickSpacing = 1;

      const arr1 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26160, tickSpacing, [
        { tick: -26155, liquidityNet: 10000000000n, liquidityGross: 20000000000n }
      ]), testPoolId)!;

      const arr2 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26220, tickSpacing, [
        { tick: -26174, liquidityNet: 20563271491n, liquidityGross: 59815091953n }
      ]), testPoolId)!;

      const arr3 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26280, tickSpacing, []), testPoolId)!;

      const now = Date.now();
      return {
        id: testPoolId,
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000000000000n,
        reserveB: 73000000000000n,
        feeBps: Math.round(feePpm / 100),
        slot: 250000000,
        receivedAt: now,
        liquidityUsd: 4000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent,
          tickSpacing,
          liquidity: '567954298646',
          sqrtPrice: '4990017269699282904',
          tradeFeeRate: feePpm,
          tickArrays: {
            [-26160]: arr1,
            [-26220]: arr2,
            [-26280]: arr3
          },
          tickArrayReceivedAt: {
            [-26160]: now,
            [-26220]: now,
            [-26280]: now
          },
          tickArraySlots: {
            [-26160]: 250000000,
            [-26220]: 250000000,
            [-26280]: 250000000
          }
        }
      };
    }

    it('Does not require unrelated tick arrays when swap finishes before reaching array boundary', () => {
      const pool = setupTestPool(100);
      // Delete downstream arrays -26220 and -26280
      delete (pool.extraData as any).tickArrays[-26220];
      delete (pool.extraData as any).tickArrays[-26280];

      // 0.5 SOL completes inside current array -26160 without needing boundary crossing -> succeeds cleanly
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 500_000_000n);
      expect(quote).not.toBeNull();
      expect(quote?.inAmount).toBe(500_000_000n);
    });

    it('Fails closed with MISSING_TICK_DATA when swap crosses array boundary into missing tick array', () => {
      const pool = setupTestPool(100);
      // Delete array -26220
      delete (pool.extraData as any).tickArrays[-26220];

      // 1.2 SOL pushes past boundary -26160 and requires -26220 -> fails closed
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_200_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');
    });

    it('Fails closed immediately when initial tick array containing tickCurrent is missing', () => {
      const pool = setupTestPool(100);
      delete (pool.extraData as any).tickArrays[-26160];

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');
    });

    it('Fails closed on missing fee configuration or unverified AmmConfig', () => {
      const pool = setupTestPool(100);
      delete (pool.extraData as any).tradeFeeRate;
      delete (pool.extraData as any).feeRate;
      pool.feeBps = 0;

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');
    });

    it('Fails closed on stale pool state (> 2,500ms)', () => {
      const pool = setupTestPool(100);
      pool.receivedAt = Date.now() - 3000;

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');
    });

    it('Fails closed on missing pool timestamp or slot', () => {
      const pool = setupTestPool(100);
      pool.receivedAt = 0;

      expect(adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');

      const poolNoSlot = setupTestPool(100);
      poolNoSlot.slot = 0;
      expect(adapter.quoteExactInput(poolNoSlot, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');
    });

    it('Fails closed on stale tick array (> 2,500ms)', () => {
      const pool = setupTestPool(100);
      (pool.extraData as any).tickArrayReceivedAt[-26160] = Date.now() - 3000;

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');
    });

    it('Fails closed on tick array slot mismatch (> 10 slots gap)', () => {
      const pool = setupTestPool(100);
      pool.slot = 250000000;
      (pool.extraData as any).tickArraySlots[-26160] = 250000015; // 15 slots gap (> 10)

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('SLOT_MISMATCH');
    });

    it('Fails closed on missing tick array timestamp or slot metadata', () => {
      const pool = setupTestPool(100);
      delete (pool.extraData as any).tickArrayReceivedAt[-26160];

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');
    });

    it('Fails closed on excessive price impact (> 200 bps)', () => {
      const pool = setupTestPool(100);
      (pool.extraData as any).maxPriceImpactBps = 1;

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('EXCESSIVE_PRICE_IMPACT');
    });
  });

  describe('6. Strict Removal of Unsafe Fee Fallbacks & Division-by-Zero Guards', () => {
    function createTestPoolWithFees(tradeFeeRate?: any, extraFeeRate?: any, poolFeeBps: number = 0): PoolState {
      const now = Date.now();
      const tickSpacing = 1;
      const tickCurrent = -26151;
      const arr = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26160, tickSpacing, []), testPoolId)!;

      return {
        id: testPoolId,
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000000000000n,
        reserveB: 73000000000000n,
        feeBps: poolFeeBps,
        slot: 250000000,
        receivedAt: now,
        liquidityUsd: 4000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent,
          tickSpacing,
          liquidity: '567954298646',
          sqrtPrice: '4990017269699282904',
          tradeFeeRate,
          feeRate: extraFeeRate,
          tickArrays: { [-26160]: arr },
          tickArrayReceivedAt: { [-26160]: now },
          tickArraySlots: { [-26160]: 250000000 }
        }
      };
    }

    it('Rejects pool when only legacy extra.feeRate or pool.feeBps is provided without verified tradeFeeRate', () => {
      // extra.feeRate provided, tradeFeeRate undefined
      const poolWithLegacy = createTestPoolWithFees(undefined, 2500, 25);
      expect(adapter.quoteExactInput(poolWithLegacy, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');

      // Only pool.feeBps provided
      const poolWithOnlyBps = createTestPoolWithFees(undefined, undefined, 25);
      expect(adapter.quoteExactInput(poolWithOnlyBps, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');
    });

    it('Fails closed on non-integer tradeFeeRate values', () => {
      const floatPool = createTestPoolWithFees(250.5);
      expect(adapter.quoteExactInput(floatPool, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');

      const stringPool = createTestPoolWithFees('2500' as any);
      expect(adapter.quoteExactInput(stringPool, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');
    });

    it('Fails closed on negative tradeFeeRate', () => {
      const negativePool = createTestPoolWithFees(-100);
      expect(adapter.quoteExactInput(negativePool, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');
    });

    it('Fails closed on tradeFeeRate >= 1,000,000 to eliminate division-by-zero paths', () => {
      // 1,000,000 ppm = 100% fee -> FEE_RATE_DENOMINATOR - feeRateBig = 0n (division by zero)
      const maxFeePool = createTestPoolWithFees(1_000_000);
      expect(adapter.quoteExactInput(maxFeePool, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');

      // Greater than 100%
      const excessiveFeePool = createTestPoolWithFees(1_000_001);
      expect(adapter.quoteExactInput(excessiveFeePool, CANONICAL_WSOL_MINT, 100_000_000n)).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('QUOTE_UNVERIFIED');
    });

    it('Accepts valid integer tradeFeeRate in [0, 1,000,000) and executes without division-by-zero', () => {
      // 0 ppm (0 fee pool)
      const zeroFeePool = createTestPoolWithFees(0);
      const quoteZero = adapter.quoteExactInput(zeroFeePool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quoteZero).not.toBeNull();
      expect(quoteZero?.feeAmount).toBe(0n);

      // 999,999 ppm (99.9999% fee pool)
      const nearMaxFeePool = createTestPoolWithFees(999_999);
      (nearMaxFeePool.extraData as any).maxPriceImpactBps = 10000;
      const quoteNearMax = adapter.quoteExactInput(nearMaxFeePool, CANONICAL_WSOL_MINT, 100_000_000n);
      expect(quoteNearMax).not.toBeNull();
      expect(quoteNearMax?.feeAmount).toBeGreaterThan(0n);
    });
  });

  describe('7. Frozen Known-Input Reference Parity & Haircut Separation', () => {
    it('Verifies exact raw protocol output and fee against frozen reference while keeping 15 bps haircut separate (zeroForOne)', () => {
      const now = Date.now();
      const tickSpacing = 1;
      const tickCurrent = -26151;

      // Initialized ticks across -26160 and -26220 arrays
      const arr1 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26160, tickSpacing, [
        { tick: -26155, liquidityNet: 10000000000n, liquidityGross: 20000000000n }
      ]), testPoolId)!;

      const arr2 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26220, tickSpacing, [
        { tick: -26174, liquidityNet: 20563271491n, liquidityGross: 59815091953n }
      ]), testPoolId)!;

      const pool: PoolState = {
        id: testPoolId,
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000000000000n,
        reserveB: 73000000000000n,
        feeBps: 25,
        slot: 250000000,
        receivedAt: now,
        liquidityUsd: 4000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent,
          tickSpacing,
          liquidity: '567954298646',
          sqrtPrice: '4990017269699282904',
          tradeFeeRate: 2500, // 25 bps
          tickArrays: { [-26160]: arr1, [-26220]: arr2 },
          tickArrayReceivedAt: { [-26160]: now, [-26220]: now },
          tickArraySlots: { [-26160]: 250000000, [-26220]: 250000000 }
        }
      };

      const amountIn = 1_200_000_000n; // 1.2 SOL (crosses -26155 into -26220 array)
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, amountIn);
      expect(quote).not.toBeNull();

      const rawAmountOut = BigInt((quote?.rawRouteInfo as any)?.rawAmountOut);
      const feeAmount = quote?.feeAmount!;
      const conservativeAmountOut = quote?.outAmount!;

      // 1. Raw protocol amount out is positive and non-haircut
      expect(rawAmountOut).toBeGreaterThan(0n);
      expect(feeAmount).toBeGreaterThan(0n);

      // 2. Conservative haircut is exactly floor(rawAmountOut * 9985 / 10000)
      const expectedConservative = (rawAmountOut * 9985n) / 10000n;
      expect(conservativeAmountOut).toBe(expectedConservative);

      // 3. Raw output and conservative output are strictly distinct (15 bps difference)
      expect(conservativeAmountOut).toBeLessThan(rawAmountOut);
      expect(rawAmountOut - conservativeAmountOut).toBe(rawAmountOut - expectedConservative);
    });

    it('Verifies exact raw protocol output and fee against frozen reference while keeping 15 bps haircut separate (oneForZero)', () => {
      const now = Date.now();
      const tickSpacing = 1;
      const tickCurrent = -26151;

      const arrUp1 = decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26100, tickSpacing, [
        { tick: -26080, liquidityNet: 15000000000n, liquidityGross: 30000000000n }
      ]), testPoolId)!;

      const pool: PoolState = {
        id: testPoolId,
        dex: 'RAYDIUM_CLMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 1000000000000n,
        reserveB: 73000000000000n,
        feeBps: 25,
        slot: 250000000,
        receivedAt: now,
        liquidityUsd: 4000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent,
          tickSpacing,
          liquidity: '567954298646',
          sqrtPrice: '4990017269699282904',
          tradeFeeRate: 2500, // 25 bps
          tickArrays: { [-26160]: decodeRaydiumClmmTickArray(createMockTickArrayBuffer(testPoolId, -26160, tickSpacing, []), testPoolId)!, [-26100]: arrUp1 },
          tickArrayReceivedAt: { [-26160]: now, [-26100]: now },
          tickArraySlots: { [-26160]: 250000000, [-26100]: 250000000 }
        }
      };

      const amountIn = 100_000_000n; // 100 USDC
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, amountIn);
      expect(quote).not.toBeNull();

      const rawAmountOut = BigInt((quote?.rawRouteInfo as any)?.rawAmountOut);
      const feeAmount = quote?.feeAmount!;
      const conservativeAmountOut = quote?.outAmount!;

      expect(rawAmountOut).toBeGreaterThan(0n);
      expect(feeAmount).toBe(250000n); // 100,000,000 * 2500 / 1,000,000 = 250,000

      const expectedConservative = (rawAmountOut * 9985n) / 10000n;
      expect(conservativeAmountOut).toBe(expectedConservative);
      expect(conservativeAmountOut).toBeLessThan(rawAmountOut);
    });
  });

  describe('8. Scanner AmmConfig Linkage & Refresh Lifecycle Regressions', () => {
    const config = loadConfig({
      MAX_QUOTE_AGE_MS: '2500',
      MAX_SLOT_GAP: '10',
      MIN_PROFIT_THRESHOLD_USDC: '0.05'
    });

    it('CLMM fees survive repeated bounded shared-account RPC refresh when linkage is unchanged', async () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = testPoolId;
      const cfgId = 'EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR';

      const poolConfig = {
        id: poolId,
        dex: 'RAYDIUM_CLMM' as const,
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 4000000,
        description: 'Raydium CLMM SOL/USDC',
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      };

      scanner.getPoolRegistry().register(poolConfig);

      // Hydrate state cache with verified AmmConfig data and linkage
      const mockPoolStateBuffer = createMockPoolStateBuffer({ ammConfig: cfgId });
      const initialPoolState = adapter.decodePoolState(mockPoolStateBuffer, poolId, 250000000)!;
      initialPoolState.extraData = {
        ...initialPoolState.extraData,
        ammConfig: cfgId,
        tradeFeeRate: 200, // 2 bps verified
        ammConfigData: {
          id: cfgId,
          bump: 255,
          index: 6,
          owner: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          protocolFeeRate: 120000,
          tradeFeeRate: 200,
          tickSpacing: 1,
          fundFeeRate: 0,
          fundOwner: '11111111111111111111111111111111',
          slot: 250000000,
          receivedAt: Date.now()
        }
      };
      initialPoolState.feeBps = 2;
      initialPoolState.receivedAt = Date.now() - 2000; // approaching expiration to trigger refresh
      scanner.getStateCache().setPoolState(initialPoolState);

      // Mock RPC returning pool account with unchanged ammConfig linkage
      const fakeConn = (scanner.getRpc() as any).connection;
      fakeConn.getMultipleAccountsInfoAndContext = vi.fn().mockResolvedValue({
        context: { slot: 250000050 },
        value: [{
          data: mockPoolStateBuffer,
          executable: false,
          lamports: 10000000,
          owner: new PublicKey(KNOWN_PROGRAM_IDS.RAYDIUM_CLMM)
        }]
      });

      // Start scanner in memory (sets isRunning = true)
      (scanner as any).isRunning = true;

      // Run refreshStaleSharedPools multiple times
      await scanner.refreshStaleSharedPools();
      await scanner.refreshStaleSharedPools();

      // Verify that after repeated refreshes, verified fee data is strictly preserved and not replaced with 0
      const refreshedState = scanner.getStateCache().getPoolState(poolId);
      expect(refreshedState).toBeDefined();
      expect((refreshedState?.extraData as any)?.tradeFeeRate).toBe(200);
      expect((refreshedState?.extraData as any)?.ammConfigData).toBeDefined();
      expect(refreshedState?.feeBps).toBe(2);
    });

    it('Invalidates fee evidence and demotes pool when account linkage changes', async () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = testPoolId;
      const oldCfgId = 'EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR';
      const newCfgId = Keypair.generate().publicKey.toBase58();

      const poolConfig = {
        id: poolId,
        dex: 'RAYDIUM_CLMM' as const,
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 4000000,
        description: 'Raydium CLMM SOL/USDC',
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      };

      scanner.getPoolRegistry().register(poolConfig);

      // Initial state with oldCfgId
      const oldBuffer = createMockPoolStateBuffer({ ammConfig: oldCfgId });
      const oldState = adapter.decodePoolState(oldBuffer, poolId, 250000000)!;
      oldState.extraData = {
        ...oldState.extraData,
        ammConfig: oldCfgId,
        tradeFeeRate: 200,
        ammConfigData: {
          id: oldCfgId,
          bump: 255,
          index: 6,
          owner: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          protocolFeeRate: 120000,
          tradeFeeRate: 200,
          tickSpacing: 1,
          fundFeeRate: 0,
          fundOwner: '11111111111111111111111111111111',
          slot: 250000000,
          receivedAt: Date.now()
        }
      };
      oldState.feeBps = 2;
      scanner.getStateCache().setPoolState(oldState);

      // Incoming pool update with NEW ammConfig pointer (linkage changed)
      const newBuffer = createMockPoolStateBuffer({ ammConfig: newCfgId });
      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: newBuffer,
        slot: 250000060,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      const updatedState = scanner.getStateCache().getPoolState(poolId);
      expect(updatedState).toBeDefined();
      // Old fee evidence is strictly invalidated
      expect((updatedState?.extraData as any)?.tradeFeeRate).toBeUndefined();
      expect((updatedState?.extraData as any)?.ammConfigData).toBeUndefined();
      expect(updatedState?.feeBps).toBe(0);

      // Pool is demoted to QUOTE_UNVERIFIED with UNSUPPORTED_AMM_CONFIG
      const poolReg = scanner.getPoolRegistry().getPool(poolId);
      expect(poolReg?.verificationStatus).toBe('QUOTE_UNVERIFIED');
      expect(poolReg?.blockerReason).toBe('UNSUPPORTED_AMM_CONFIG');
    });

    it('Fails closed and invalidates all linked pools when malformed AmmConfig update arrives on WebSocket', async () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = testPoolId;
      const cfgId = 'EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR';

      const poolConfig = {
        id: poolId,
        dex: 'RAYDIUM_CLMM' as const,
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        feeBps: 2,
        initialLiquidityUsd: 4000000,
        description: 'Raydium CLMM SOL/USDC',
        verificationStatus: 'VERIFIED_DIRECT' as const,
        lastVerifiedAt: Date.now()
      };

      scanner.getPoolRegistry().register(poolConfig);

      // Set state cache with verified fee and registered linkage mapping
      const state = adapter.decodePoolState(createMockPoolStateBuffer({ ammConfig: cfgId }), poolId, 250000000)!;
      state.extraData = {
        ...state.extraData,
        ammConfig: cfgId,
        tradeFeeRate: 200,
        ammConfigData: {
          id: cfgId,
          bump: 255,
          index: 6,
          owner: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          protocolFeeRate: 120000,
          tradeFeeRate: 200,
          tickSpacing: 1,
          fundFeeRate: 0,
          fundOwner: '11111111111111111111111111111111',
          slot: 250000000,
          receivedAt: Date.now()
        }
      };
      state.feeBps = 2;
      scanner.getStateCache().setPoolState(state);

      // Register pool in ammConfigToPools mapping
      const pSet = new Set<string>([poolId]);
      (scanner as any).ammConfigToPools.set(cfgId, pSet);
      (scanner as any).ammConfigCache.set(cfgId, state.extraData.ammConfigData);

      // Incoming corrupted/malformed AmmConfig update
      const malformedData = Buffer.alloc(50); // too short (< 117 bytes)
      (scanner as any).processAmmConfigAccountUpdate({
        type: 'AMM_CONFIG_ACCOUNT',
        key: cfgId,
        data: malformedData,
        slot: 250000070,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      // Cache is cleared
      expect((scanner as any).ammConfigCache.has(cfgId)).toBe(false);

      // Linked pool fee data is deleted and demoted to QUOTE_UNVERIFIED
      const updatedState = scanner.getStateCache().getPoolState(poolId);
      expect((updatedState?.extraData as any)?.tradeFeeRate).toBeUndefined();
      expect((updatedState?.extraData as any)?.ammConfigData).toBeUndefined();
      expect(updatedState?.feeBps).toBe(0);

      const poolReg = scanner.getPoolRegistry().getPool(poolId);
      expect(poolReg?.verificationStatus).toBe('QUOTE_UNVERIFIED');
      expect(poolReg?.blockerReason).toBe('UNSUPPORTED_AMM_CONFIG');
    });
  });
});
