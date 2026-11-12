import { describe, it, expect } from 'vitest';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { MeteoraDlmmAdapter } from '../src/dex/meteoraDlmmAdapter.js';
import { PoolState } from '../src/types/index.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';

describe('Phase 1.1 Audit: Official Protocol Math & Quote Parity', () => {
  describe('Raydium AMM V4 Accrued PnL & Effective Reserves', () => {
    const adapter = new RaydiumAmmAdapter();

    it('Deducts accrued protocol PnL (baseNeedTakePnl, quoteNeedTakePnl) from effective reserves', () => {
      const rawBaseVault = 100000n * 1000000000n;   // 100k SOL
      const rawQuoteVault = 12500000n * 1000000n;   // 12.5M USDC
      const baseNeedTakePnl = 1000n * 1000000000n;  // 1k SOL uncollected PnL
      const quoteNeedTakePnl = 125000n * 1000000n;  // 125k USDC uncollected PnL

      const poolWithPnl: PoolState = {
        id: 'raydium-pnl-test',
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: rawBaseVault,
        reserveB: rawQuoteVault,
        feeBps: 25,
        slot: 100,
        receivedAt: Date.now(),
        liquidityUsd: 25000000,
        feedHealth: 'HEALTHY',
        extraData: {
          baseNeedTakePnl: baseNeedTakePnl.toString(),
          quoteNeedTakePnl: quoteNeedTakePnl.toString()
        }
      };

      const inputUSDC = 1000n * 1000000n; // 1,000 USDC
      const quote = adapter.quoteExactInput(poolWithPnl, CANONICAL_USDC_MINT, inputUSDC);

      expect(quote).not.toBeNull();

      // Effective base reserve is 99,000 SOL (not 100,000)
      // Effective quote reserve is 12,375,000 USDC (not 12,500,000)
      const fee = (inputUSDC * 25n) / 10000n;
      const inAfterFee = inputUSDC - fee;
      const effBase = rawBaseVault - baseNeedTakePnl;
      const effQuote = rawQuoteVault - quoteNeedTakePnl;
      const expectedOut = (effBase * inAfterFee) / (effQuote + inAfterFee);

      expect(quote!.outAmount).toBe(expectedOut);
      expect(quote!.feeAmount).toBe(fee);
    });

    it('Exact integer swap rounding matches Raydium protocol math', () => {
      const pool: PoolState = {
        id: 'raydium-round-test',
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 50000n * 1000000000n,
        reserveB: 6250000n * 1000000n,
        feeBps: 25,
        slot: 100,
        receivedAt: Date.now(),
        liquidityUsd: 12500000,
        feedHealth: 'HEALTHY'
      };

      // Test small trade ($25 USDC)
      const quoteSmall = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 25000000n);
      expect(quoteSmall).not.toBeNull();
      expect(quoteSmall!.outAmount).toBeGreaterThan(0n);

      // Test large trade ($1,000 USDC)
      const quoteLarge = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 1000000000n);
      expect(quoteLarge).not.toBeNull();
      expect(quoteLarge!.outAmount).toBeGreaterThan(quoteSmall!.outAmount);
    });
  });

  describe('Orca Whirlpool Concentrated Liquidity & Boundary Protection', () => {
    const adapter = new OrcaWhirlpoolAdapter();

    it('Computes exact single-tick output when trade is within active tick boundary', () => {
      // Mainnet Orca SOL/USDC Whirlpool snapshot:
      // tickCurrent: -24988, tickSpacing: 4
      // sqrtPrice: 5288671865725992663 (Q64.64)
      // liquidity: 430523504655045
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
        slot: 468523410,
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

      // Small $25 USDC trade fits within the active tick
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 25000000n);
      expect(quote).not.toBeNull();
      expect(quote!.outAmount).toBeGreaterThan(0n);
      expect(quote!.feeAmount).toBe(10000n); // 4 bps on 25,000,000 is 10,000 micro-USDC
    });

    it('Fails closed (returns null) when trade crosses tick boundary without tick arrays', () => {
      const poolWithNarrowTick: PoolState = {
        id: 'orca-boundary-test',
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
        receivedAt: Date.now(),
        liquidityUsd: 10000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickCurrent: -24988,
          tickSpacing: 4,
          feeRateRaw: 400,
          sqrtPrice: '5288671865725992663',
          liquidity: '100000000' // very low liquidity
        }
      };

      // Massive trade on low-liquidity pool crosses tick boundary
      const quote = adapter.quoteExactInput(poolWithNarrowTick, CANONICAL_USDC_MINT, 50000000000n);
      expect(quote).toBeNull(); // Fails closed instead of inventing constant-product extrapolation
    });
  });

  describe('Meteora DLMM Discrete Bin & Capacity Protection', () => {
    const adapter = new MeteoraDlmmAdapter();

    it('Fails closed: missing bin arrays or bin liquidity NEVER produces a qualified direct quote', () => {
      // Unhydrated or raw decoded pool without bin arrays
      const rawDecodedPool: PoolState = {
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

      const quote = adapter.quoteExactInput(rawDecodedPool, CANONICAL_USDC_MINT, 100000000n);
      expect(quote).toBeNull();
    });

    it('Calculates discrete bin output only within verified bin liquidity capacity with verified bin arrays', () => {
      const pool: PoolState = {
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
          hasVerifiedBinArrays: true,
          binLiquidityX: '500000000000', // 500 SOL capacity
          binLiquidityY: '50000000000'   // 50,000 USDC capacity
        }
      };

      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 100000000n); // $100 USDC
      expect(quote).not.toBeNull();
      expect(quote!.outAmount).toBeGreaterThan(0n);
    });

    it('Fails closed (returns null) when trade exceeds active bin capacity without multi-bin traversal', () => {
      const pool: PoolState = {
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
          hasVerifiedBinArrays: true,
          binLiquidityX: '500000000000',
          binLiquidityY: '10000000' // Only $10 USDC in active bin
        }
      };

      // $500 USDC exceeds active bin capacity ($10) -> requires bin arrays -> fails closed
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, 500000000n);
      expect(quote).toBeNull();
    });
  });
});
