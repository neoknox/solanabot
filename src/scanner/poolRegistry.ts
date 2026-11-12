import { DexType, PoolState } from '../types/index.js';
import {
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT,
  KNOWN_PROGRAM_IDS
} from '../config/index.js';

export type VerificationStatus = 'VERIFIED_DIRECT' | 'QUOTE_UNVERIFIED';

export interface PoolConfig {
  id: string;
  dex: DexType;
  programId: string;
  tokenAMint: string;
  tokenBMint: string;
  feeBps: number;
  initialLiquidityUsd?: number;
  description?: string;
  verificationStatus?: VerificationStatus;
  blockerReason?: string;
}

export class PoolRegistry {
  private pools = new Map<string, PoolConfig>();

  constructor() {
    this.registerDefaultPools();
  }

  private registerDefaultPools(): void {
    // 1. Raydium AMM V4 (Standard SOL/USDC - dynamic runtime verification)
    this.register({
      id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 25,
      initialLiquidityUsd: 15000000,
      description: 'Raydium AMM V4 Main SOL/USDC Pool',
      verificationStatus: 'QUOTE_UNVERIFIED',
      blockerReason: 'PENDING_RUNTIME_VERIFICATION'
    });

    // 2. Orca Whirlpool (0.04% / 4 bps primary SOL/USDC Whirlpool, verified on-chain)
    this.register({
      id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 4,
      initialLiquidityUsd: 32000000,
      description: 'Orca Whirlpool 0.04% SOL/USDC',
      verificationStatus: 'VERIFIED_DIRECT'
    });

    // 3. Orca Whirlpool Secondary (FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q, verified on-chain 2 bps)
    // Intra-DEX counterpart to Czfq3xZZ
    this.register({
      id: 'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 2,
      initialLiquidityUsd: 1200000,
      description: 'Orca Whirlpool 0.02% SOL/USDC (Intra-DEX tier)',
      verificationStatus: 'VERIFIED_DIRECT'
    });

    // 4. Meteora DLMM (Primary dynamic bin pool - marked QUOTE_UNVERIFIED without bin-array streaming)
    this.register({
      id: 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR',
      dex: 'METEORA_DLMM',
      programId: KNOWN_PROGRAM_IDS.METEORA_DLMM,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 10,
      initialLiquidityUsd: 500000,
      description: 'Meteora DLMM Dynamic Bin SOL/USDC (QUOTE_UNVERIFIED: pending bin-array streaming)',
      verificationStatus: 'QUOTE_UNVERIFIED',
      blockerReason: 'MISSING_BIN_ARRAYS'
    });

    // 5. Orca Whirlpool USDC/USDT 0.01% (verified on-chain, 653-byte layout)
    this.register({
      id: '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4',
      dex: 'ORCA_WHIRLPOOL',
      programId: KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL,
      tokenAMint: CANONICAL_USDC_MINT,
      tokenBMint: CANONICAL_USDT_MINT,
      feeBps: 1,
      initialLiquidityUsd: 25000000,
      description: 'Orca Whirlpool 0.01% USDC/USDT Stable Pair',
      verificationStatus: 'VERIFIED_DIRECT'
    });

    // 6. Raydium AMM V4 WSOL/USDT (dynamic runtime verification)
    this.register({
      id: '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDT_MINT,
      feeBps: 25,
      initialLiquidityUsd: 8500000,
      description: 'Raydium AMM V4 Main SOL/USDT Pool',
      verificationStatus: 'QUOTE_UNVERIFIED',
      blockerReason: 'PENDING_RUNTIME_VERIFICATION'
    });

    // 7. Raydium CLMM (Concentrated Liquidity, verified on-chain)
    this.register({
      id: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',
      dex: 'RAYDIUM_CLMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_CLMM,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 4,
      initialLiquidityUsd: 4000000,
      description: 'Raydium CLMM SOL/USDC',
      verificationStatus: 'QUOTE_UNVERIFIED',
      blockerReason: 'PENDING_ORDERBOOK_STREAMING'
    });

    // 8. Phoenix Market (Orderbook DEX on Solana, verified on-chain)
    this.register({
      id: '4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg',
      dex: 'PHOENIX',
      programId: KNOWN_PROGRAM_IDS.PHOENIX,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      feeBps: 2,
      initialLiquidityUsd: 8000000,
      description: 'Phoenix Orderbook SOL/USDC Market',
      verificationStatus: 'QUOTE_UNVERIFIED',
      blockerReason: 'PENDING_ORDERBOOK_STREAMING'
    });
  }

  public register(pool: PoolConfig): void {
    this.pools.set(pool.id, pool);
  }

  public getPool(id: string): PoolConfig | undefined {
    return this.pools.get(id);
  }

  public getAllPools(): PoolConfig[] {
    return Array.from(this.pools.values());
  }

  public getPoolsByDex(dex: DexType): PoolConfig[] {
    return Array.from(this.pools.values()).filter(p => p.dex === dex);
  }

  public updatePoolVerification(id: string, status: VerificationStatus, blockerReason?: string): void {
    const pool = this.pools.get(id);
    if (pool) {
      pool.verificationStatus = status;
      pool.blockerReason = blockerReason;
    }
  }

  public isPoolVerified(id: string): boolean {
    const pool = this.pools.get(id);
    return pool?.verificationStatus === 'VERIFIED_DIRECT';
  }
}
