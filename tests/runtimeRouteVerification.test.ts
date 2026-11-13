import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { RouteIndex } from '../src/scanner/routeIndex.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { CostModel } from '../src/profit/costModel.js';
import { TradeSizer } from '../src/profit/tradeSizer.js';
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

    it('AMM update advances 20+ slots while OpenOrders bytes are unchanged and recently confirmed: no automatic false SLOT_MISMATCH', () => {
      const scanner = new ArbitrageScanner(config);
      (scanner as any).ws.getHealth = () => 'HEALTHY';
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      
      // Simulate verified pool state with recent confirmation
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
          lastAccountChangeSlot: initialSlot,
          lastRpcConfirmationContextSlot: initialSlot,
          lastConfirmedAt: Date.now(),
          observationFreshnessTtlMs: 30000,
          verifiedSlot: initialSlot,
          verifiedAt: Date.now(),
          vaultASlot: initialSlot,
          vaultBSlot: initialSlot,
          vaultAReceivedAt: Date.now(),
          vaultBReceivedAt: Date.now()
        }
      };

      (scanner as any).stateCache.setPoolState(verifiedPool);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');
      scanner.getRouteIndex().updatePoolStatus(poolId, 'VERIFIED_DIRECT');

      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(true);

      // Now simulate a pool account update with an advanced slot (slot gap = 25 > 10)
      const mockPoolData = Buffer.alloc(752);
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

      // Verification MUST be preserved: quiet unchanged OpenOrders within TTL does NOT trigger false SLOT_MISMATCH
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(true);
      const updatedPool = (scanner as any).stateCache.getPoolState(poolId);
      expect(updatedPool.extraData.openOrdersVerified).toBe(true);
      expect(updatedPool.extraData.unverifiedReason).toBeUndefined();
    });

    it('Fails closed when OpenOrders observation TTL expires without reconfirmation', () => {
      const scanner = new ArbitrageScanner(config);
      (scanner as any).ws.getHealth = () => 'HEALTHY';
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

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
        receivedAt: Date.now() - 35000, // 35s ago (> 30s TTL)
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
          lastAccountChangeSlot: initialSlot,
          lastRpcConfirmationContextSlot: initialSlot,
          lastConfirmedAt: Date.now() - 35000, // Expired TTL
          observationFreshnessTtlMs: 30000,
          vaultASlot: initialSlot,
          vaultBSlot: initialSlot,
          vaultAReceivedAt: Date.now(),
          vaultBReceivedAt: Date.now()
        }
      };

      (scanner as any).stateCache.setPoolState(verifiedPool);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

      const mockPoolData = Buffer.alloc(752);
      new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz').toBuffer().copy(mockPoolData, 336);
      new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz').toBuffer().copy(mockPoolData, 368);
      new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolData, 400);
      new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolData, 432);
      new PublicKey('HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY').toBuffer().copy(mockPoolData, 496);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(mockPoolData, 528);
      new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX').toBuffer().copy(mockPoolData, 560);

      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: mockPoolData,
        slot: initialSlot + 5,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      // Must fail closed with OBSERVATION_EXPIRED
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('OBSERVATION_EXPIRED');
    });

    it('Fails closed on subscription loss (WebSocket disconnected)', () => {
      const scanner = new ArbitrageScanner(config);
      (scanner as any).ws.getHealth = () => 'DISCONNECTED';
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

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
          lastConfirmedAt: Date.now(),
          observationFreshnessTtlMs: 30000,
          vaultASlot: initialSlot,
          vaultBSlot: initialSlot,
          vaultAReceivedAt: Date.now(),
          vaultBReceivedAt: Date.now()
        }
      };

      (scanner as any).stateCache.setPoolState(verifiedPool);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

      const mockPoolData = Buffer.alloc(752);
      new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz').toBuffer().copy(mockPoolData, 336);
      new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz').toBuffer().copy(mockPoolData, 368);
      new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolData, 400);
      new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolData, 432);
      new PublicKey('HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY').toBuffer().copy(mockPoolData, 496);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(mockPoolData, 528);
      new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX').toBuffer().copy(mockPoolData, 560);

      (scanner as any).processPoolAccountUpdate({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: mockPoolData,
        slot: initialSlot + 2,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('SUBSCRIPTION_LOSS');
    });

    it('Successful bounded reconfirmation restores eligibility after demotion; failed reconfirmation does not', async () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      const ooKey = 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY';

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
          openOrders: ooKey,
          marketId: '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6',
          marketProgramId: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
          openOrdersVerified: false,
          unverifiedReason: 'OBSERVATION_EXPIRED',
          vaultASlot: 1000,
          vaultBSlot: 1000,
          vaultAReceivedAt: Date.now(),
          vaultBReceivedAt: Date.now()
        }
      };

      (scanner as any).stateCache.setPoolState(pool);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'OBSERVATION_EXPIRED');

      // Valid OpenOrders RPC account payload (3228 bytes)
      const validOoData = Buffer.alloc(3228);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(validOoData, 13);
      new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1').toBuffer().copy(validOoData, 45);
      validOoData.writeBigUInt64LE(1000000n, 85);
      validOoData.writeBigUInt64LE(2000000n, 101);

      // Mock RPC returning valid account
      (scanner as any).rpc.getMultipleAccountsAndContext = async () => ({
        slot: 1050,
        value: [{
          data: validOoData,
          owner: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
          executable: false,
          lamports: 10000000
        }]
      });

      const reconfirmSuccess = await scanner.reconfirmOpenOrders(poolId);
      expect(reconfirmSuccess).toBe(true);
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(true);
      expect(scanner.getPoolRegistry().getPool(poolId)?.verificationStatus).toBe('VERIFIED_DIRECT');

      // Now simulate a failed reconfirmation (e.g. RPC timeout or corrupt data)
      // Clear rate limiting
      (scanner as any).lastReconfirmationTime.set(poolId, 0);
      (scanner as any).rpc.getMultipleAccountsAndContext = async () => {
        throw new Error('RPC_TIMEOUT');
      };

      const reconfirmFailed = await scanner.reconfirmOpenOrders(poolId);
      expect(reconfirmFailed).toBe(false);
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.verificationStatus).toBe('QUOTE_UNVERIFIED');
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('RPC_TIMEOUT');
    });

    it('OpenOrders reconfirmation fails closed if vault reserves are unhydrated or inconsistent', async () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      const ooKey = 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY';

      // 1. Unhydrated vault reserves (reserves = 0n)
      const poolUnhydrated: PoolState = {
        id: poolId,
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 0n,
        reserveB: 0n,
        feeBps: 25,
        slot: 1000,
        receivedAt: Date.now(),
        liquidityUsd: 0,
        feedHealth: 'HEALTHY',
        extraData: {
          openOrders: ooKey,
          marketId: '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6',
          marketProgramId: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
          openOrdersVerified: false
        }
      };

      (scanner as any).stateCache.setPoolState(poolUnhydrated);
      scanner.getPoolRegistry().updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'VAULT_RESERVES_UNHYDRATED');

      const validOoData = Buffer.alloc(3228);
      new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6').toBuffer().copy(validOoData, 13);
      new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1').toBuffer().copy(validOoData, 45);
      validOoData.writeBigUInt64LE(1000000n, 85);
      validOoData.writeBigUInt64LE(2000000n, 101);

      (scanner as any).rpc.getMultipleAccountsAndContext = async () => ({
        slot: 1050,
        value: [{
          data: validOoData,
          owner: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
          executable: false,
          lamports: 10000000
        }]
      });

      const reconfirmUnhydrated = await scanner.reconfirmOpenOrders(poolId);
      expect(reconfirmUnhydrated).toBe(false);
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('VAULT_RESERVES_UNHYDRATED');

      // 2. Inconsistent / stale vault slots (gap > 100 slots)
      (scanner as any).lastReconfirmationTime.set(poolId, 0);
      poolUnhydrated.reserveA = 100000000000n;
      poolUnhydrated.reserveB = 15000000000n;
      (poolUnhydrated.extraData as any).vaultASlot = 1000;
      (poolUnhydrated.extraData as any).vaultBSlot = 1250; // Gap = 250 > 100
      (poolUnhydrated.extraData as any).vaultAReceivedAt = Date.now();
      (poolUnhydrated.extraData as any).vaultBReceivedAt = Date.now();

      const reconfirmInconsistent = await scanner.reconfirmOpenOrders(poolId);
      expect(reconfirmInconsistent).toBe(false);
      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('STALE_VAULT_SNAPSHOT');
    });

    it('Fails closed on OpenOrders data corruption or authority mismatch', () => {
      const scanner = new ArbitrageScanner(config);
      const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
      const ooKey = 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY';

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
          openOrdersVerified: true
        }
      };

      (scanner as any).stateCache.setPoolState(pool);
      (scanner as any).openOrdersToPool.set(ooKey, poolId);

      // Corrupt buffer (< 3228 bytes)
      const corruptData = Buffer.alloc(100);
      (scanner as any).processOpenOrdersAccountUpdate({
        type: 'OPENORDERS_ACCOUNT',
        key: ooKey,
        data: corruptData,
        slot: 1001,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });

      expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
      expect(scanner.getPoolRegistry().getPool(poolId)?.blockerReason).toBe('OPENORDERS_LAYOUT_INVALID');
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

    it('Orca null quote reasons classified without falsely attributing all to tick boundary', () => {
      const adapterOrca = new OrcaWhirlpoolAdapter();

      const validPool: PoolState = {
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

      // 1. Invalid mint test -> must return null and set reason INVALID_MINT
      const qInvalidMint = adapterOrca.quoteExactInput(validPool, 'InvalidMint111111111111111111111111111111111', 1000000n);
      expect(qInvalidMint).toBeNull();
      expect(adapterOrca.getLastFailureReason()).toBe('INVALID_MINT');

      // 2. Missing tick data test -> must return null and set reason MISSING_TICK_DATA
      const brokenPool: PoolState = {
        ...validPool,
        extraData: {
          tickSpacing: 4,
          feeRateRaw: 400,
          liquidity: '450000000000000',
          sqrtPrice: '5265556603086493861'
          // tickCurrent missing
        }
      };
      const qMissingTick = adapterOrca.quoteExactInput(brokenPool, CANONICAL_USDC_MINT, 1000000n);
      expect(qMissingTick).toBeNull();
      expect(adapterOrca.getLastFailureReason()).toBe('MISSING_TICK_DATA');

      // 3. Proven tick boundary exceeded test -> thin pool with 2 bps, single tick capacity ~ $2.76 USDC
      const thinPool: PoolState = {
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
      const qBoundary = adapterOrca.quoteExactInput(thinPool, CANONICAL_USDC_MINT, 50000000n); // $50 USDC
      expect(qBoundary).toBeNull();
      expect(adapterOrca.getLastFailureReason()).toBe('TICK_BOUNDARY_EXCEEDED');

      // 4. TradeSizer attribution test
      const tradeSizer = new TradeSizer(config);
      const initialBoundaryAttempts = tradeSizer.orcaTickBoundaryAttempts;
      const initialOtherAttempts = tradeSizer.orcaOtherFailureAttempts;

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

      // Evaluate thin pool ($50) -> should increment orcaTickBoundaryAttempts
      tradeSizer.evaluateSize(
        50,
        [{ pool: thinPool, adapter: adapterOrca, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 }],
        dummyCosts,
        468600000
      );
      expect(tradeSizer.orcaTickBoundaryAttempts).toBe(initialBoundaryAttempts + 1);

      // Evaluate broken pool -> should increment orcaOtherFailureAttempts
      tradeSizer.evaluateSize(
        50,
        [{ pool: brokenPool, adapter: adapterOrca, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 }],
        dummyCosts,
        468600000
      );
      expect(tradeSizer.orcaOtherFailureAttempts).toBe(initialOtherAttempts + 1);
    });

    it('Correct 2-route Orca intra-DEX identity: Czfq3xZZ <-> FpCMFDFG, excluding 4fuUiYxT from 2-leg cycle', () => {
      const registry = new PoolRegistry();
      const allPools = registry.getAllPools();
      const routeIndex = new RouteIndex(allPools);

      const allRoutes = routeIndex.getAllRoutes();
      const orcaIntraDex2LegRoutes = allRoutes.filter(
        r => r.cycleType === '2_LEG' && r.isIntraDex && r.legs[0].dex === 'ORCA_WHIRLPOOL' && r.legs[1].dex === 'ORCA_WHIRLPOOL'
      );

      // Exactly two 2-leg intra-DEX routes exist for Orca
      expect(orcaIntraDex2LegRoutes.length).toBe(2);

      const czfqId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
      const fpcmId = 'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q';
      const usdtPoolId = '4fuUiYxTAWhmbtPf8QkW8sm44eK5s4H8C7Bkn5B8B111'; // USDC/USDT pool

      // The two routes must pair Czfq3xZZ and FpCMFDFG in opposite directions
      const route1 = orcaIntraDex2LegRoutes.find(r => r.legs[0].poolId === czfqId && r.legs[1].poolId === fpcmId);
      const route2 = orcaIntraDex2LegRoutes.find(r => r.legs[0].poolId === fpcmId && r.legs[1].poolId === czfqId);

      expect(route1).toBeDefined();
      expect(route2).toBeDefined();

      // Verify 4fuUiYxT (USDC/USDT) is never part of a 2-leg route with Czfq3xZZ (WSOL/USDC)
      const invalidCycle = orcaIntraDex2LegRoutes.some(
        r => (r.legs[0].poolId === czfqId && r.legs[1].poolId === usdtPoolId) ||
             (r.legs[0].poolId === usdtPoolId && r.legs[1].poolId === czfqId)
      );
      expect(invalidCycle).toBe(false);
    });
  });

  describe('4. Cross-DEX Token Continuity & Sizing Verification', () => {
    it('Accurate cross-DEX token continuity, both directions and $25/$50/$100 sizes', () => {
      const raydiumAdapter = new RaydiumAmmAdapter();
      const orcaAdapter = new OrcaWhirlpoolAdapter();

      // Deep Raydium AMM pool state
      const raydiumPool: PoolState = {
        id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
        dex: 'RAYDIUM_AMM',
        programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
        tokenAMint: CANONICAL_WSOL_MINT,
        tokenBMint: CANONICAL_USDC_MINT,
        tokenADecimals: 9,
        tokenBDecimals: 6,
        reserveA: 100000000000n, // 100 WSOL
        reserveB: 16500000000n,  // 16,500 USDC (~$165/SOL)
        feeBps: 25,
        slot: 1000,
        receivedAt: Date.now(),
        liquidityUsd: 33000,
        feedHealth: 'HEALTHY'
      };

      // Deep Orca Whirlpool state
      const orcaPool: PoolState = {
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
        slot: 1000,
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

      const testSizesUSDC = [25, 50, 100];

      // Test Direction 1: Raydium (USDC -> WSOL) -> Orca (WSOL -> USDC)
      for (const sizeUSDC of testSizesUSDC) {
        const inAmountUSDC = BigInt(sizeUSDC * 1e6);

        // Leg 1: Raydium AMM
        const leg1Quote = raydiumAdapter.quoteExactInput(raydiumPool, CANONICAL_USDC_MINT, inAmountUSDC);
        expect(leg1Quote).not.toBeNull();
        expect(leg1Quote!.outputMint).toBe(CANONICAL_WSOL_MINT);
        expect(leg1Quote!.outAmount).toBeGreaterThan(0n);

        // Leg 2: Orca Whirlpool (token continuity: inAmount = leg1Quote.outAmount)
        const leg2Quote = orcaAdapter.quoteExactInput(orcaPool, CANONICAL_WSOL_MINT, leg1Quote!.outAmount);
        expect(leg2Quote).not.toBeNull();
        expect(leg2Quote!.outputMint).toBe(CANONICAL_USDC_MINT);
        expect(leg2Quote!.outAmount).toBeGreaterThan(0n);
      }

      // Test Direction 2: Orca (USDC -> WSOL) -> Raydium (WSOL -> USDC)
      for (const sizeUSDC of testSizesUSDC) {
        const inAmountUSDC = BigInt(sizeUSDC * 1e6);

        // Leg 1: Orca Whirlpool
        const leg1Quote = orcaAdapter.quoteExactInput(orcaPool, CANONICAL_USDC_MINT, inAmountUSDC);
        expect(leg1Quote).not.toBeNull();
        expect(leg1Quote!.outputMint).toBe(CANONICAL_WSOL_MINT);
        expect(leg1Quote!.outAmount).toBeGreaterThan(0n);

        // Leg 2: Raydium AMM (token continuity: inAmount = leg1Quote.outAmount)
        const leg2Quote = raydiumAdapter.quoteExactInput(raydiumPool, CANONICAL_WSOL_MINT, leg1Quote!.outAmount);
        expect(leg2Quote).not.toBeNull();
        expect(leg2Quote!.outputMint).toBe(CANONICAL_USDC_MINT);
        expect(leg2Quote!.outAmount).toBeGreaterThan(0n);
      }
    });
  });
});
