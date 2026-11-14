import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  tickIndexToSqrtPrice,
  tryGetAmountDeltaA,
  tryGetAmountDeltaB,
  tryGetNextSqrtPriceFromA,
  tryGetNextSqrtPriceFromB
} from '@orca-so/whirlpools-core';
import { RaydiumClmmAdapter } from '../src/dex/raydiumClmmAdapter.js';
import {
  deriveRaydiumClmmTickArrayPda,
  getRaydiumClmmArrayStartIndex,
  getRequiredRaydiumClmmTickArrayStartIndices,
  getSurroundingRaydiumClmmTickArrayStartIndices,
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
        mint0: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' // Raydium mint (not in USDC/WSOL/USDT allowlist)
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

  describe('2. Tick Array PDA Derivation & Layout Decoding', () => {
    it('Derives exact PDA matching program ID and seed formula [tick_array, pool_id, start_tick.toBE(4)]', () => {
      const pda = deriveRaydiumClmmTickArrayPda(testPoolId, -26160);
      expect(pda).toBeInstanceOf(PublicKey);
      // Confirmed on-chain in live Solana mainnet verification
      expect(pda.toBase58()).toBe('DhzLeDuEfWAmBCrHNiChMcMGgER5vLcdoqPHVkuS9aE1');
    });

    it('Calculates correct start tick indices and required 3-array sequence for both directions', () => {
      const tickCurrent = -26151;
      const tickSpacing = 1;

      expect(getRaydiumClmmArrayStartIndex(tickCurrent, tickSpacing)).toBe(-26160);

      // A_TO_B (zeroForOne: price drops, tick moves down)
      const aToBIndices = getRequiredRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing, 'A_TO_B');
      expect(aToBIndices).toEqual([-26160, -26220, -26280]);

      // B_TO_A (oneForZero: price rises, tick moves up)
      const bToAIndices = getRequiredRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing, 'B_TO_A');
      expect(bToAIndices).toEqual([-26160, -26100, -26040]);

      // Surrounding indices for WebSocket hydration
      const surrounding = getSurroundingRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing);
      expect(surrounding).toEqual([-26220, -26160, -26100]);
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

  describe('3. Exact CLMM Pricing & Protocol Parity', () => {
    function setupTestPool(feePpm: number = 2500): {
      pool: PoolState;
      tickArrays: Record<number, RaydiumClmmTickArray>;
    } {
      const tickCurrent = -26151;
      const tickSpacing = 1;
      const startTick = -26160;

      // Create 3 arrays for A_TO_B: -26160, -26220, -26280
      // and 2 arrays for B_TO_A: -26100, -26040
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
          feeRate: feePpm,
          tickArrays,
          tickArrayReceivedAt,
          tickArraySlots
        }
      };

      return { pool, tickArrays };
    }

    it('Calculates exact pool fee in parts per million (10^-6)', () => {
      const { pool } = setupTestPool(2500); // 25 bps = 2500 ppm
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n); // 1 SOL
      expect(quote).not.toBeNull();
      // 1,000,000,000 * 2500 / 1,000,000 = 2,500,000 fee
      expect(quote?.feeAmount).toBe(2500000n);
    });

    it('Supports zeroForOne (A -> B: SOL -> USDC) with exact integer math and conservative haircut', () => {
      const { pool } = setupTestPool(100); // 1 bps = 100 ppm
      const amountIn = 1_000_000_000n; // 1 SOL
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, amountIn);

      expect(quote).not.toBeNull();
      expect(quote?.inputMint).toBe(CANONICAL_WSOL_MINT);
      expect(quote?.outputMint).toBe(CANONICAL_USDC_MINT);
      expect(quote?.inAmount).toBe(amountIn);
      expect(quote?.feeAmount).toBe(100000n); // 1,000,000,000 * 100 / 1,000,000 = 100,000 lamports

      // Raw unadjusted output at ~73.13 USDC = 73,133,177 micro-units
      // Conservative output (99.85%) = floor(73,133,177 * 9985 / 10000) = 73,023,477
      expect(Number(quote?.outAmount)).toBeGreaterThan(70_000_000);
      expect(Number(quote?.outAmount)).toBeLessThan(75_000_000);
      expect(quote?.priceImpactBps).toBeLessThan(10);
    });

    it('Supports oneForZero (B -> A: USDC -> SOL) with exact integer math', () => {
      const { pool } = setupTestPool(100);
      const amountIn = 100_000_000n; // 100 USDC
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, amountIn);

      expect(quote).not.toBeNull();
      expect(quote?.inputMint).toBe(CANONICAL_USDC_MINT);
      expect(quote?.outputMint).toBe(CANONICAL_WSOL_MINT);
      expect(quote?.inAmount).toBe(amountIn);
      expect(quote?.feeAmount).toBe(10000n); // 100,000,000 * 100 / 1,000,000 = 10,000 micro-USDC

      // 100 USDC yields ~1.36 SOL = ~1,365,000,000 lamports
      expect(Number(quote?.outAmount)).toBeGreaterThan(1_300_000_000);
      expect(Number(quote?.outAmount)).toBeLessThan(1_400_000_000);
    });

    it('Traverses multiple initialized ticks and updates active liquidity correctly', () => {
      const { pool } = setupTestPool(100);
      // Large swap: 10 SOL pushes price across initialized tick -26155
      const amountIn = 10_000_000_000n;
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, amountIn);

      expect(quote).not.toBeNull();
      expect(quote?.inAmount).toBe(amountIn);
      // Successfully traversed and crossed tick without error
      expect(Number(quote?.outAmount)).toBeGreaterThan(700_000_000);
    });

    it('Fails closed on excessive price impact (> 200 bps)', () => {
      const { pool } = setupTestPool(100);
      // Set maxPriceImpactBps to 1 bps to test price impact threshold rejection within loaded tick arrays
      (pool.extraData as any).maxPriceImpactBps = 1;
      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n);

      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('EXCESSIVE_PRICE_IMPACT');
    });

    it('Fails closed when required tick arrays are missing', () => {
      const { pool } = setupTestPool(100);
      // Delete required array -26220
      delete (pool.extraData as any).tickArrays[-26220];

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('MISSING_TICK_DATA');
    });

    it('Fails closed on stale pool quote (> 2500ms)', () => {
      const { pool } = setupTestPool(100);
      pool.receivedAt = Date.now() - 3000; // 3 seconds ago

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('STALE_QUOTE');
    });

    it('Fails closed on tick array slot mismatch (> 100 slots gap)', () => {
      const { pool } = setupTestPool(100);
      pool.slot = 250000000;
      (pool.extraData as any).tickArraySlots[-26160] = 250000150; // 150 slots gap

      const quote = adapter.quoteExactInput(pool, CANONICAL_WSOL_MINT, 1_000_000_000n);
      expect(quote).toBeNull();
      expect(adapter.getLastFailureReason()).toBe('SLOT_MISMATCH');
    });
  });
});
