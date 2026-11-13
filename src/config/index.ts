import dotenv from 'dotenv';
import { z } from 'zod';
import { TokenInfo } from '../types/index.js';

dotenv.config();

// Canonical Mint Definitions
export const CANONICAL_WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const CANONICAL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CANONICAL_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const ALLOWLISTED_MINTS = new Set([
  CANONICAL_WSOL_MINT,
  CANONICAL_USDC_MINT,
  CANONICAL_USDT_MINT
]);

export const KNOWN_TOKENS: Record<string, TokenInfo> = {
  [CANONICAL_WSOL_MINT]: {
    mint: CANONICAL_WSOL_MINT,
    symbol: 'WSOL',
    decimals: 9,
    name: 'Wrapped SOL',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  },
  [CANONICAL_USDC_MINT]: {
    mint: CANONICAL_USDC_MINT,
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  },
  [CANONICAL_USDT_MINT]: {
    mint: CANONICAL_USDT_MINT,
    symbol: 'USDT',
    decimals: 6,
    name: 'Tether USD',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  }
};

export function getKnownTokenDecimals(mint: string): number {
  const token = KNOWN_TOKENS[mint];
  if (token) return token.decimals;
  if (mint === CANONICAL_WSOL_MINT) return 9;
  if (mint === CANONICAL_USDC_MINT || mint === CANONICAL_USDT_MINT) return 6;
  return 6;
}

// Verified On-Chain Mainnet Program IDs
export const KNOWN_PROGRAM_IDS = {
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022_PROGRAM: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  METEORA_DAMM: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  OPENBOOK_V2: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
  PANCAKESWAP: 'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq',
  MANIFEST: 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms',
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
} as const;

const rawConfigSchema = z.object({
  SOLANA_RPC_HTTP: z.string().url().default('https://api.mainnet-beta.solana.com'),
  SOLANA_RPC_WS: z.string().default('wss://api.mainnet-beta.solana.com'),
  JUPITER_API_KEY: z.string().optional().default(''),
  JUPITER_API_URL: z.string().url().default('https://api.jup.ag/swap/v1'),
  SCAN_TOKENS: z.string().default('SOL,USDC,USDT'),
  TRADE_SIZES_USDC: z.string().default('25,50,100,250,500,1000'),
  VIRTUAL_CAPITAL_USDC: z.coerce.number().positive().default(1000),
  MIN_NET_PROFIT_USDC: z.coerce.number().min(0.01).default(0.50),
  SAFETY_BUFFER_USDC: z.coerce.number().min(0).default(0.25),
  SLIPPAGE_BPS_LEG1: z.coerce.number().min(0).max(500).default(10),
  SLIPPAGE_BPS_LEG2: z.coerce.number().min(0).max(500).default(10),
  SLIPPAGE_BPS_LEG3: z.coerce.number().min(0).max(500).default(10),
  MAX_QUOTE_AGE_MS: z.coerce.number().min(100).max(60000).default(2500),
  MAX_SLOT_GAP: z.coerce.number().min(0).max(200).default(10),
  OPENORDERS_OBSERVATION_TTL_MS: z.coerce.number().min(1000).default(30000),
  MIN_POOL_LIQUIDITY_USD: z.coerce.number().min(0).default(10000),
  MAX_PRICE_IMPACT_BPS: z.coerce.number().min(1).max(5000).default(200),
  MAX_EXECUTION_COST_USDC: z.coerce.number().min(0).default(0.30),
  NETWORK_FEE_LAMPORTS_PER_SIGNATURE: z.coerce.number().min(0).default(5000),
  ESTIMATED_SIGNATURES: z.coerce.number().min(1).max(10).default(1),
  PRIORITY_FEE_LAMPORTS: z.coerce.number().min(0).default(10000),
  JITO_TIP_LAMPORTS: z.coerce.number().min(0).default(0),
  ATA_RENT_EXEMPT_LAMPORTS: z.coerce.number().default(2039280),
  EXECUTION_CONTINGENCY_USDC: z.coerce.number().min(0).default(0.02),
  POLL_INTERVAL_MS: z.coerce.number().min(500).default(3000),
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().min(1000).default(10000),
  JUPITER_RATE_LIMIT_RPS: z.coerce.number().min(0.1).default(1),
  RPC_RATE_LIMIT_RPS: z.coerce.number().min(0.5).default(5),
  DB_PATH: z.string().default('./data/arbitrage_scanner.db'),
  DB_RETENTION_HOURS: z.coerce.number().min(1).default(24),
  LOG_ALL_REJECTED: z.coerce.boolean().default(false),
  WS_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('processed'),
  MAX_EVENT_QUEUE_CAPACITY: z.coerce.number().min(100).default(2000),
  ASYNC_DB_FLUSH_INTERVAL_MS: z.coerce.number().min(10).default(100),
  SCAN_INTERVAL_MS: z.coerce.number().min(50).default(500),
  ENABLE_OPTIMAL_SIZING: z.coerce.boolean().default(true),
  ENABLE_THREE_LEG_CYCLES: z.coerce.boolean().default(true),
  ENABLE_INTRA_DEX_CYCLES: z.coerce.boolean().default(true),
  HUD_PORT: z.coerce.number().min(1024).max(65535).default(3030),
  PROFIT_THRESHOLD_FILE: z.string().default('./data/profit_threshold.json'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});

export type RawConfig = z.infer<typeof rawConfigSchema>;

export interface AppConfig extends RawConfig {
  parsedTradeSizesUSDC: number[];
  parsedScanTokens: string[];
}

export function loadConfig(envOverrides: Record<string, string | undefined> = {}): AppConfig {
  const mergedEnv = { ...process.env, ...envOverrides };
  const parsed = rawConfigSchema.safeParse(mergedEnv);

  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`[Configuration Error] Invalid environment configuration: ${errorDetails}`);
  }

  const raw = parsed.data;
  const parsedTradeSizesUSDC = raw.TRADE_SIZES_USDC
    .split(',')
    .map(s => parseFloat(s.trim()))
    .filter(n => !isNaN(n) && n > 0 && n <= raw.VIRTUAL_CAPITAL_USDC)
    .sort((a, b) => a - b);

  if (parsedTradeSizesUSDC.length === 0) {
    throw new Error('[Configuration Error] TRADE_SIZES_USDC must contain at least one valid number <= VIRTUAL_CAPITAL_USDC');
  }

  const parsedScanTokens = raw.SCAN_TOKENS
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  return {
    ...raw,
    parsedTradeSizesUSDC,
    parsedScanTokens
  };
}

export const config = loadConfig();
