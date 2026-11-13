import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { TradeSizer, QuoterLeg } from '../src/profit/tradeSizer.js';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import {
  loadConfig,
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  KNOWN_PROGRAM_IDS
} from '../src/config/index.js';
import { PoolState, CostBreakdown, SwapQuote } from '../src/types/index.js';

describe('Final Raydium Safety Gate - Regression Suite', () => {
  const config = loadConfig();
  const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const ooPubkeyStr = 'HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY';
  const baseVaultStr = 'DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz';
  const quoteVaultStr = 'HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz';
  const marketIdStr = '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6';
  const marketProgramIdStr = 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX';

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

  function createValidOpenOrdersBuffer(): Buffer {
    const buf = Buffer.alloc(3228);
    new PublicKey(marketIdStr).toBuffer().copy(buf, 13);
    new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1').toBuffer().copy(buf, 45);
    buf.writeBigUInt64LE(1000000n, 85);
    buf.writeBigUInt64LE(2000000n, 101);
    return buf;
  }

  // REGRESSION 1: OpenOrders valid, Vault A stale
  it('1. OpenOrders valid, Vault A stale fails closed and clears quote verification flag', async () => {
    const scanner = new ArbitrageScanner(config);
    const initialSlot = 1000;
    const now = Date.now();

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
      slot: initialSlot,
      receivedAt: now,
      liquidityUsd: 30000000,
      feedHealth: 'HEALTHY',
      extraData: {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        openOrders: ooPubkeyStr,
        marketId: marketIdStr,
        marketProgramId: marketProgramIdStr,
        openOrdersVerified: true,
        openOrdersBaseTokenTotal: '1000000',
        openOrdersQuoteTokenTotal: '2000000',
        openOrdersSlot: initialSlot,
        vaultASlot: initialSlot,
        vaultBSlot: initialSlot,
        vaultAReceivedAt: now - 45000, // Stale: 45s ago (> 30s TTL)
        vaultBReceivedAt: now,
        observationFreshnessTtlMs: 30000
      }
    };

    (scanner as any).stateCache.setPoolState(pool);
    scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

    (scanner as any).rpc.getMultipleAccountsAndContext = async () => ({
      slot: initialSlot,
      value: [{
        data: createValidOpenOrdersBuffer(),
        owner: new PublicKey(marketProgramIdStr),
        executable: false,
        lamports: 10000000
      }]
    });

    const success = await scanner.reconfirmOpenOrders(poolId);
    expect(success).toBe(false);

    // Metadata flag MUST be cleared on validation failure
    const updatedState = (scanner as any).stateCache.getPoolState(poolId);
    expect(updatedState.extraData.openOrdersVerified).toBe(false);
    expect(updatedState.extraData.unverifiedReason).toBe('STALE_VAULT_SNAPSHOT');
    expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
    expect(scanner.getPoolRegistry().getPool(poolId)?.verificationStatus).toBe('QUOTE_UNVERIFIED');

    // Quote adapter must classify as UNVERIFIED
    const adapter = new RaydiumAmmAdapter();
    const quote = adapter.quoteExactInput(updatedState, CANONICAL_USDC_MINT, 100000000n);
    expect(quote).not.toBeNull();
    expect(quote!.quoteSource).toBe('UNVERIFIED');
    expect((quote as any).isUnverified).toBe(true);
    expect((quote as any).unverifiedReason).toBe('STALE_VAULT_SNAPSHOT');
  });

  // REGRESSION 2: OpenOrders valid, Vault B unhydrated
  it('2. OpenOrders valid, Vault B unhydrated fails closed and prevents promotion', async () => {
    const scanner = new ArbitrageScanner(config);
    const initialSlot = 1000;
    const now = Date.now();

    const pool: PoolState = {
      id: poolId,
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 100000000000n,
      reserveB: 0n, // Unhydrated reserve B
      feeBps: 25,
      slot: initialSlot,
      receivedAt: now,
      liquidityUsd: 0,
      feedHealth: 'HEALTHY',
      extraData: {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        openOrders: ooPubkeyStr,
        marketId: marketIdStr,
        marketProgramId: marketProgramIdStr,
        openOrdersVerified: false,
        vaultASlot: initialSlot,
        vaultBSlot: initialSlot,
        vaultAReceivedAt: now,
        vaultBReceivedAt: now,
        observationFreshnessTtlMs: 30000
      }
    };

    (scanner as any).stateCache.setPoolState(pool);

    (scanner as any).rpc.getMultipleAccountsAndContext = async () => ({
      slot: initialSlot,
      value: [{
        data: createValidOpenOrdersBuffer(),
        owner: new PublicKey(marketProgramIdStr),
        executable: false,
        lamports: 10000000
      }]
    });

    const success = await scanner.reconfirmOpenOrders(poolId);
    expect(success).toBe(false);

    const updatedState = (scanner as any).stateCache.getPoolState(poolId);
    expect(updatedState.extraData.openOrdersVerified).toBe(false);
    expect(updatedState.extraData.unverifiedReason).toBe('VAULT_RESERVES_UNHYDRATED');
    expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);

    const adapter = new RaydiumAmmAdapter();
    const quote = adapter.quoteExactInput(updatedState, CANONICAL_USDC_MINT, 100000000n);
    expect(quote).toBeNull();
    expect(adapter.getLastFailureReason()).toBe('INSUFFICIENT_LIQUIDITY');
  });

  // REGRESSION 3: Both vault timestamps missing
  it('3. Both vault timestamps missing fails closed with MISSING_VAULT_METADATA without substituting pool.receivedAt', async () => {
    const scanner = new ArbitrageScanner(config);
    const initialSlot = 1000;
    const now = Date.now();

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
      slot: initialSlot,
      receivedAt: now,
      liquidityUsd: 30000000,
      feedHealth: 'HEALTHY',
      extraData: {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        openOrders: ooPubkeyStr,
        marketId: marketIdStr,
        marketProgramId: marketProgramIdStr,
        openOrdersVerified: true,
        // Both vault timestamps and slots are completely missing
        observationFreshnessTtlMs: 30000
      }
    };

    (scanner as any).stateCache.setPoolState(pool);

    (scanner as any).rpc.getMultipleAccountsAndContext = async () => ({
      slot: initialSlot,
      value: [{
        data: createValidOpenOrdersBuffer(),
        owner: new PublicKey(marketProgramIdStr),
        executable: false,
        lamports: 10000000
      }]
    });

    const success = await scanner.reconfirmOpenOrders(poolId);
    expect(success).toBe(false);

    const updatedState = (scanner as any).stateCache.getPoolState(poolId);
    expect(updatedState.extraData.openOrdersVerified).toBe(false);
    expect(updatedState.extraData.unverifiedReason).toBe('MISSING_VAULT_METADATA');
    expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
  });

  // REGRESSION 4: Pool-account update preserves metadata
  it('4. Pool-account update preserves vault observation metadata and verified state when pointers are unchanged', () => {
    const scanner = new ArbitrageScanner(config);
    (scanner as any).ws.getHealth = () => 'HEALTHY';
    const initialSlot = 1000;
    const now = Date.now();

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
      receivedAt: now,
      liquidityUsd: 30000000,
      feedHealth: 'HEALTHY',
      extraData: {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        openOrders: ooPubkeyStr,
        marketId: marketIdStr,
        marketProgramId: marketProgramIdStr,
        openOrdersVerified: true,
        openOrdersBaseTokenTotal: '1000000',
        openOrdersQuoteTokenTotal: '2000000',
        openOrdersSlot: initialSlot,
        lastAccountChangeSlot: initialSlot,
        lastRpcConfirmationContextSlot: initialSlot,
        lastConfirmedAt: now,
        observationFreshnessTtlMs: 30000,
        verifiedSlot: initialSlot,
        verifiedAt: now,
        vaultASlot: initialSlot,
        vaultBSlot: initialSlot,
        vaultAReceivedAt: now,
        vaultBReceivedAt: now
      }
    };

    (scanner as any).stateCache.setPoolState(verifiedPool);
    scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');
    scanner.getRouteIndex().updatePoolStatus(poolId, 'VERIFIED_DIRECT');

    const mockPoolData = Buffer.alloc(752);
    new PublicKey(baseVaultStr).toBuffer().copy(mockPoolData, 336);
    new PublicKey(quoteVaultStr).toBuffer().copy(mockPoolData, 368);
    new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolData, 400);
    new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolData, 432);
    new PublicKey(ooPubkeyStr).toBuffer().copy(mockPoolData, 496);
    new PublicKey(marketIdStr).toBuffer().copy(mockPoolData, 528);
    new PublicKey(marketProgramIdStr).toBuffer().copy(mockPoolData, 560);

    // Deliver POOL_ACCOUNT update advancing 10 slots with unchanged pointers
    (scanner as any).processPoolAccountUpdate({
      type: 'POOL_ACCOUNT',
      key: poolId,
      data: mockPoolData,
      slot: initialSlot + 10,
      receivedAtMs: now + 500,
      monotonicReceiptTime: performance.now()
    });

    const updated = (scanner as any).stateCache.getPoolState(poolId);
    expect(updated.extraData.openOrdersVerified).toBe(true);
    expect(updated.extraData.vaultASlot).toBe(initialSlot);
    expect(updated.extraData.vaultBSlot).toBe(initialSlot);
    expect(updated.extraData.vaultAReceivedAt).toBe(now);
    expect(updated.extraData.vaultBReceivedAt).toBe(now);
    expect(updated.reserveA).toBe(100000000000n);
    expect(updated.reserveB).toBe(15000000000n);
    expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(true);
  });

  // REGRESSION 5: Changed vault pointer invalidates state
  it('5. Changed vault pointer invalidates state and does not recycle old reserves', () => {
    const scanner = new ArbitrageScanner(config);
    const initialSlot = 1000;
    const now = Date.now();

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
      receivedAt: now,
      liquidityUsd: 30000000,
      feedHealth: 'HEALTHY',
      extraData: {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        openOrders: ooPubkeyStr,
        marketId: marketIdStr,
        marketProgramId: marketProgramIdStr,
        openOrdersVerified: true,
        vaultASlot: initialSlot,
        vaultBSlot: initialSlot,
        vaultAReceivedAt: now,
        vaultBReceivedAt: now
      }
    };

    (scanner as any).stateCache.setPoolState(verifiedPool);
    scanner.getPoolRegistry().updatePoolVerification(poolId, 'VERIFIED_DIRECT');

    const changedVault = '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'; // Different key
    const mockPoolData = Buffer.alloc(752);
    new PublicKey(changedVault).toBuffer().copy(mockPoolData, 336); // Base vault changed
    new PublicKey(quoteVaultStr).toBuffer().copy(mockPoolData, 368);
    new PublicKey(CANONICAL_WSOL_MINT).toBuffer().copy(mockPoolData, 400);
    new PublicKey(CANONICAL_USDC_MINT).toBuffer().copy(mockPoolData, 432);
    new PublicKey(ooPubkeyStr).toBuffer().copy(mockPoolData, 496);
    new PublicKey(marketIdStr).toBuffer().copy(mockPoolData, 528);
    new PublicKey(marketProgramIdStr).toBuffer().copy(mockPoolData, 560);

    (scanner as any).processPoolAccountUpdate({
      type: 'POOL_ACCOUNT',
      key: poolId,
      data: mockPoolData,
      slot: initialSlot + 1,
      receivedAtMs: now + 100,
      monotonicReceiptTime: performance.now()
    });

    const updated = (scanner as any).stateCache.getPoolState(poolId);
    expect(updated.extraData.openOrdersVerified).toBe(false);
    expect(updated.extraData.unverifiedReason).toBe('ACCOUNT_POINTERS_CHANGED');
    expect(updated.reserveA).toBe(0n); // Old reserves MUST NOT be recycled
    expect(updated.reserveB).toBe(0n);
    expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(false);
    expect(scanner.getPoolRegistry().getPool(poolId)?.verificationStatus).toBe('QUOTE_UNVERIFIED');
  });

  // REGRESSION 6: Unverified Raydium quote NEVER qualifies
  it('6. Unverified Raydium quote NEVER qualifies in trade sizer or profit calculator', () => {
    const sizer = new TradeSizer(config);
    const calculator = new ArbitrageProfitCalculator(config);
    const adapter = new RaydiumAmmAdapter();

    const unverifiedPool: PoolState = {
      id: poolId,
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 1000000000000n,
      reserveB: 150000000000n,
      feeBps: 25,
      slot: 1000,
      receivedAt: Date.now(),
      liquidityUsd: 1000000,
      feedHealth: 'HEALTHY',
      extraData: {
        openOrdersVerified: false,
        unverifiedReason: 'STALE_VAULT_SNAPSHOT'
      }
    };

    const legs: QuoterLeg[] = [
      { pool: unverifiedPool, adapter, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
      { pool: unverifiedPool, adapter, inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
    ];

    // Sizer evaluation MUST fail closed
    const sizerResult = sizer.evaluateSize(100, legs, dummyCosts, 1000);
    expect(sizerResult.isViable).toBe(false);
    expect(sizerResult.rejectionReason).toBe('STALE_VAULT_SNAPSHOT');
    expect(sizerResult.expectedQuotes.length).toBe(0);

    // Calculator candidate MUST be REJECTED / INVALID
    const rawQuote: SwapQuote = adapter.quoteExactInput(unverifiedPool, CANONICAL_USDC_MINT, 100000000n)!;
    expect(rawQuote.quoteSource).toBe('UNVERIFIED');

    const candidate = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: rawQuote,
      leg2Quote: rawQuote,
      costs: dummyCosts,
      currentSlot: 1000,
      wsConnected: true
    });

    expect(candidate.status).toBe('UNSUPPORTED');
    expect(candidate.qualityLabel).toBe('INDICATIVE_ONLY');
    expect(candidate.status).not.toBe('QUALIFIED_SHADOW');
    expect(candidate.qualityLabel).not.toBe('SHADOW_QUALIFIED');
    expect(candidate.rejectionReasons).toContain('QUOTE_UNVERIFIED');
    expect(candidate.rejectionReasons).toContain('STALE_VAULT_SNAPSHOT');
  });

  // REGRESSION 7: Recovery succeeds after valid fresh data
  it('7. Recovery succeeds after valid fresh vault and open orders data', async () => {
    const scanner = new ArbitrageScanner(config);
    const initialSlot = 1000;
    const now = Date.now();

    // Pool starts as UNVERIFIED due to stale vaults
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
      slot: initialSlot,
      receivedAt: now,
      liquidityUsd: 30000000,
      feedHealth: 'HEALTHY',
      extraData: {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        openOrders: ooPubkeyStr,
        marketId: marketIdStr,
        marketProgramId: marketProgramIdStr,
        openOrdersVerified: false,
        unverifiedReason: 'STALE_VAULT_SNAPSHOT',
        vaultASlot: initialSlot,
        vaultBSlot: initialSlot,
        vaultAReceivedAt: now - 45000,
        vaultBReceivedAt: now - 45000,
        observationFreshnessTtlMs: 30000
      }
    };

    (scanner as any).stateCache.setPoolState(pool);
    scanner.getPoolRegistry().updatePoolVerification(poolId, 'QUOTE_UNVERIFIED', 'STALE_VAULT_SNAPSHOT');

    // Deliver fresh vault A update
    (scanner as any).vaultToPool.set(baseVaultStr, { poolId, isA: true });
    (scanner as any).vaultToPool.set(quoteVaultStr, { poolId, isA: false });

    const vaultABuf = Buffer.alloc(72);
    vaultABuf.writeBigUInt64LE(110000000000n, 64);
    (scanner as any).processVaultAccountUpdate({
      type: 'VAULT_ACCOUNT',
      key: baseVaultStr,
      data: vaultABuf,
      slot: initialSlot + 20,
      receivedAtMs: Date.now(),
      monotonicReceiptTime: performance.now()
    });

    const vaultBBuf = Buffer.alloc(72);
    vaultBBuf.writeBigUInt64LE(16000000000n, 64);
    (scanner as any).processVaultAccountUpdate({
      type: 'VAULT_ACCOUNT',
      key: quoteVaultStr,
      data: vaultBBuf,
      slot: initialSlot + 20,
      receivedAtMs: Date.now(),
      monotonicReceiptTime: performance.now()
    });

    // Provide RPC response with valid OpenOrders
    (scanner as any).rpc.getMultipleAccountsAndContext = async () => ({
      slot: initialSlot + 20,
      value: [{
        data: createValidOpenOrdersBuffer(),
        owner: new PublicKey(marketProgramIdStr),
        executable: false,
        lamports: 10000000
      }]
    });

    // Reconfirm OpenOrders with now-fresh vaults
    const recovered = await scanner.reconfirmOpenOrders(poolId);
    expect(recovered).toBe(true);

    const recoveredPool = (scanner as any).stateCache.getPoolState(poolId);
    expect(recoveredPool.extraData.openOrdersVerified).toBe(true);
    expect(recoveredPool.extraData.unverifiedReason).toBeUndefined();
    expect(scanner.getPoolRegistry().isPoolVerified(poolId)).toBe(true);
    expect(scanner.getPoolRegistry().getPool(poolId)?.verificationStatus).toBe('VERIFIED_DIRECT');

    // Quote is now DIRECT_POOL
    const adapter = new RaydiumAmmAdapter();
    const quote = adapter.quoteExactInput(recoveredPool, CANONICAL_USDC_MINT, 100000000n);
    expect(quote).not.toBeNull();
    expect(quote!.quoteSource).toBe('DIRECT_POOL');
    expect(quote!.executionType).toBe('POTENTIAL_ATOMIC');
  });
});
