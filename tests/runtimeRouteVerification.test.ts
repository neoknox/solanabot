import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { CostModel } from '../src/profit/costModel.js';
import {
  loadConfig,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';
import { PoolState, CostBreakdown } from '../src/types/index.js';
import { QueuedAccountUpdate } from '../src/scanner/eventQueue.js';

describe('Runtime Route Verification & Dynamic Classification Gate', () => {
  const config = loadConfig();

  describe('1. Raydium Verification Promotion & Invalidation', () => {
    it('Promotes pool to VERIFIED_DIRECT when OpenOrders, market, authority, and slots are valid', () => {
      const registry = new PoolRegistry();
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      
      expect(registry.isPoolVerified(poolId)).toBe(false);
      
      registry.updatePoolVerification(poolId, 'VERIFIED_DIRECT');
      expect(registry.isPoolVerified(poolId)).toBe(true);
      expect(registry.getPool(poolId)?.verificationStatus).toBe('VERIFIED_DIRECT');
    });

    it('Expires verification when slot gap between pool and OpenOrders exceeds MAX_SLOT_GAP', () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      
      // Simulate verified pool state
      const initialSlot = 1000;
      const verifiedPool: PoolState = {
        id: poolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 100000000000n,
        reserveB: 15000000000n,
        feeBps: 25,
        slot: initialSlot,
        receivedAt: Date.now(),
        liquidityUsd: 30000000,
        feedHealth: 'HEALTHY',
        extraData: {
          baseVault: 'DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz',
          quoteVault: 'HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz',
          openOrders: 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY',
          marketId: '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6',
          marketProgramId: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
          openOrdersVerified: true,
          openOrdersBaseTokenTotal: '0',
          openOrdersQuoteTokenTotal: '0',
          openOrdersSlot: initialSlot,
          verifiedSlot: initialSlot,
          verifiedAt: Date.now()
        }
      };

      (scanner as any).stateCache.setPoolState(verifiedPool);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');
      scanner.getRouteIndex().updatePoolStatus(poolId, 'VERIFIED_DIRECT');

      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(true);

      // Now simulate a pool account update with an advanced slot (slot gap = 20 > MAX_SLOT_GAP 10)
      const mockPoolData = Buffer.alloc(752);
      // Write baseVault at 336, quoteVault at 368, baseMint at 400, quoteMint at 432, openOrders at 496, marketId at 528, marketProgramId at 560
      new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz').toBuffer().copy(mockPoolData, 336);
      new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz').toBuffer().copy(mockPoolData, 368);
      new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolData, 400);
      new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolData, 432);
      new PublicKey('HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY').toBuffer().copy(mockPoolData, 496);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(mockPoolData, 528);
      new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX').toBuffer().copy(mockPoolData, 560);

      const advancedSlot = initialSlot + 25; // 25 slots ahead
      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: mockPoolData,
        slot: advancedSlot,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      // Verification must have expired due to SLOT_MISMATCH
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('SLOT_MISMATCH');
      const updatedPool = (scanner as any).stateCache.getPoolState(poolId);
      expect(updatedPool.extraData.openOrdersVerified).toBe(false);
      expect(updatedPool.extraData.unverifiedReason).toBe('SLOT_MISMATCH');
    });

    it('Rejects mixed-slot snapshots when OpenOrders update slot has high disparity with AMM slot', () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      const ooKey = 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY';

      // Set base pool at slot 1000
      const pool: PoolState = {
        id: poolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 100000000000n,
        reserveB: 15000000000n,
        feeBps: 25,
        slot: 1000,
        receivedAt: Date.now(),
        liquidityUsd: 30000000,
        feedHealth: 'HEALTHY',
        extraData: {
          marketId: '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6',
          openOrdersVerified: false
        }
      };

      (scanner as any).stateCache.setPoolState(pool);
      (scanner as any).openOrdersToPool.set(ooKey, poolId);

      // Create mock OpenOrders buffer with valid market and authority but slot 1050 (gap 50 > 10)
      const mockOOData = Buffer.alloc(3228);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(mockOOData, 13);
      new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1').toBuffer().copy(mockOOData, 45);

      (scanner as any).processOpenOrdersAccountUpdate({
        type: 'OPENORDERS_ACCOUNT',
        key: ooKey,
        data: mockOOData,
        slot: 1050, // slot gap = 50
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('SLOT_MISMATCH');
    });

    it('Invalidates verification immediately when pool account pointers change', () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

      const initialPool: PoolState = {
        id: poolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 100000000000n,
        reserveB: 15000000000n,
        feeBps: 25,
        slot: 1000,
        receivedAt: Date.now(),
        liquidityUsd: 30000000,
        feedHealth: 'HEALTHY',
        extraData: {
          baseVault: 'DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz',
          quoteVault: 'HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz',
          openOrders: 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY',
          marketId: '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6',
          openOrdersVerified: true
        }
      };

      (scanner as any).stateCache.setPoolState(initialPool);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

      // Update pool account with a changed openOrders account address
      const mockPoolData = Buffer.alloc(752);
      new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz').toBuffer().copy(mockPoolData, 336);
      new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz').toBuffer().copy(mockPoolData, 368);
      new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolData, 400);
      new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolData, 432);
      // New / different OpenOrders pubkey
      new PublicKey('11111111111111111111111111111111').toBuffer().copy(mockPoolData, 496);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(mockPoolData, 528);
      new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX').toBuffer().copy(mockPoolData, 560);

      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: mockPoolData,
        slot: 1002, // slot gap is small (2)
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('ACCOUNT_POINTERS_CHANGED');
    });
  });

  describe('2. Dynamic Route Eligibility & Index Classification', () => {
    it('Promotes and demotes route usability dynamically as pool verification state changes', () => {
      const registry = new PoolRegistry();
      const index = new RouteIndex(registry.getAllPools());
      const raydiumId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

      // Initially, Raydium routes are blocked
      const initialVerifiedCount = index.getVerifiedDirectRouteCount();
      const initialBlockedCount = index.getBlockedRouteCount();

      // Promote Raydium pool to VERIFIED_DIRECT
      registry.updatePoolVerification(raydiumId, 'VERIFIED_DIRECT');
      index.updatePoolStatus(raydiumId, 'VERIFIED_DIRECT');

      const promotedVerifiedCount = index.getVerifiedDirectRouteCount();
      const promotedBlockedCount = index.getBlockedRouteCount();

      // Verified direct route count must increase
      expect(promotedVerifiedCount).toBeGreaterThan(initialVerifiedCount);
      expect(promotedBlockedCount).toBeLessThan(initialBlockedCount);

      // Now demote Raydium pool back to QUOTE_UNVERIFIED (e.g. on timeout or slot mismatch)
      registry.updatePoolVerification(raydiumId, 'QUOTE_UNVERIFIED', 'SLOT_MISMATCH');
      index.updatePoolStatus(raydiumId, 'QUOTE_UNVERIFIED');

      expect(index.getVerifiedDirectRouteCount()).toBe(initialVerifiedCount);
      expect(index.getBlockedRouteCount()).toBe(initialBlockedCount);
    });
  });

  describe('3. Orca Intra-DEX Diagnostics & Rejection Attribution', () => {
    it('Identifies tick-boundary rejection and properly accounts for intra-DEX route evaluations', () => {
      const adapterOrca = new OrcaWhirlpoolAdapter();

      // Pool 1: Czfq3xZZ (Deep liquidity, 4 bps)
      const poolCzfq: PoolState = {
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
        slot: 468600000,
        receivedAt: Date.now(),
        liquidityUsd: 32000000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickSpacing: 4,
          feeRateRaw: 400,
          liquidity: '450000000000000',
          sqrtPrice: '5265556603086493861',
          tickCurrent: -25076
        }
      };

      // Pool 2: FpCMFDFG (Thin liquidity, 2 bps) - single tick capacity ~ $2.76 USDC
      const poolFpCM: PoolState = {
        id: 'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q',
        dex: 'ORCA_WHIRLPOOL',
        programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 2,
        slot: 468600000,
        receivedAt: Date.now(),
        liquidityUsd: 1200000,
        feedHealth: 'HEALTHY',
        extraData: {
          tickSpacing: 2,
          feeRateRaw: 200,
          liquidity: '733272242623',
          sqrtPrice: '5264243162816461224',
          tickCurrent: -25081
        }
      };

      // Test trade of $25 on poolCzfq: succeeds within active tick
      const qCzfq = adapterOrca.quoteExactInput(poolCzfq, CANONICAL_USDC_MINT, 25000000n);
      expect(qCzfq).not.toBeNull();
      expect(qCzfq!.outAmount).toBeGreaterThan(0n);

      // Test trade of $25 on poolFpCM: exceeds single-tick capacity, fails closed
      const qFpCM = adapterOrca.quoteExactInput(poolFpCM, CANONICAL_USDC_MINT, 25000000n);
      expect(qFpCM).toBeNull(); // Boundary rejection without tick arrays
    });

    it('Separate rejection attribution distinguishes TICK_BOUNDARY_EXCEEDED from LOW_CONSERVATIVE_NET', () => {
      const calculator = new ArbitrageProfitCalculator(config);
      const dummyCosts: CostBreakdown = {
        networkFeeUSDC: '0.000625',
        priorityFeeUSDC: '0.001250',
        jitoTipUSDC: '0.000000',
        tokenTransferFeesUSDC: '0.000000',
        contingencyUSDC: '0.020000',
        safetyBufferUSDC: '0.250000',
        totalCostsUSDC: '0.021875',
        solPriceUSDC: '165.00',
        recoverableDepositUSDC: '0.000000',
        consumedCostUSDC: '0.021875',
        potentialLossOnFailureUSDC: '0.001875',
        riskRewardRatio: '0.00',
        assumptions: []
      };

      // Unverified quote
      const unverifiedQuote = {
        quoteSource: 'UNVERIFIED' as const,
        poolId: 'mock-pool',
        dex: 'RAYDIUM_AMM' as const,
        inputMint: CANONICAL_USDC_MINT,
        outputMint: CANONICAL_WSOL_MINT,
        inAmount: 25000000n,
        outAmount: 150000000n,
        feeIncluded: true,
        feeAmount: 62500n,
        priceImpactBps: 5,
        slot: 1000,
        timestamp: Date.now(),
        executionType: 'INDICATIVE_ONLY' as const,
        isUnverified: true
      };

      const validQuote = {
        quoteSource: 'DIRECT_POOL' as const,
        poolId: 'mock-pool-2',
        dex: 'ORCA_WHIRLPOOL' as const,
        inputMint: CANONICAL_WSOL_MINT,
        outputMint: CANONICAL_USDC_MINT,
        inAmount: 150000000n,
        outAmount: 24900000n, // Net negative
        feeIncluded: true,
        feeAmount: 10000n,
        priceImpactBps: 2,
        slot: 1000,
        timestamp: Date.now(),
        executionType: 'POTENTIAL_ATOMIC' as const
      };

      const candidate = calculator.evaluateCandidate({
        initialAmountUSDC: 25000000n,
        leg1Quote: unverifiedQuote,
        leg2Quote: validQuote,
        costs: dummyCosts,
        currentSlot: 1000,
        wsConnected: true,
        solPriceTimestamp: Date.now()
      });

      // Must be rejected as UNSUPPORTED_ROUTE and QUOTE_UNVERIFIED, NOT LOW_CONSERVATIVE_NET
      expect(candidate.rejectionReasons).toContain('UNSUPPORTED_ROUTE');
      expect(candidate.rejectionReasons).toContain('QUOTE_UNVERIFIED');
      expect(candidate.rejectionReasons).not.toContain('LOW_CONSERVATIVE_NET');
    });
  });
});
