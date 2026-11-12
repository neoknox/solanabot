import { AppConfig } from '../config/index.js';
import { RouteCategory, SwapQuote, DexType, ExecutionTag } from '../types/index.js';

export interface JupiterSwapInfo {
  ammKey: string;
  label: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  feeAmount?: string;
  feeMint?: string;
}

export interface JupiterRouteLeg {
  swapInfo: JupiterSwapInfo;
  percent: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan?: JupiterRouteLeg[];
  contextSlot?: number;
  timeTaken?: number;
  error?: string;
  message?: string;
}

export interface JupiterClientStats {
  requestsTotal: number;
  requestsSuccessful: number;
  rateLimitHits: number;
  consecutiveErrors: number;
  lastLatencyMs: number;
}

export class JupiterClient {
  private config: AppConfig;
  private stats: JupiterClientStats = {
    requestsTotal: 0,
    requestsSuccessful: 0,
    rateLimitHits: 0,
    consecutiveErrors: 0,
    lastLatencyMs: 0
  };
  private minIntervalMs: number;
  private lastRequestTime = 0;
  private backoffDelayMs = 0;
  private quoteCache = new Map<string, { quote: SwapQuote; cachedAt: number }>();

  // Known proprietary or off-chain RFQ venues that are NOT composable on-chain instructions
  private static readonly RFQ_VENUES = new Set([
    'ZeroFi',
    'SolFi',
    'HumidiFi',
    'GoonFi',
    'BisonFi',
    'Bebop',
    'Banx'
  ]);

  constructor(config: AppConfig) {
    this.config = config;
    this.minIntervalMs = 1000 / config.JUPITER_RATE_LIMIT_RPS;
  }

  private async throttle(): Promise<void> {
    const totalDelay = Math.max(this.minIntervalMs, this.backoffDelayMs);
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < totalDelay) {
      await new Promise(resolve => setTimeout(resolve, totalDelay - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  public async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    dexFilter?: string
  ): Promise<SwapQuote | null> {
    const cacheKey = `${inputMint}-${outputMint}-${amount.toString()}-${dexFilter || 'ALL'}`;
    const cached = this.quoteCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.cachedAt) < 1500) {
      return cached.quote;
    }

    await this.throttle();
    const startTime = Date.now();
    this.stats.requestsTotal++;

    let url = `${this.config.JUPITER_API_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=10`;
    if (dexFilter) {
      url += `&dexes=${encodeURIComponent(dexFilter)}`;
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (this.config.JUPITER_API_KEY) {
      headers['x-api-key'] = this.config.JUPITER_API_KEY;
    }

    try {
      const res = await fetch(url, { headers });
      this.stats.lastLatencyMs = Date.now() - startTime;

      if (res.status === 429) {
        this.stats.rateLimitHits++;
        this.stats.consecutiveErrors++;
        this.backoffDelayMs = Math.min((this.backoffDelayMs || 1000) * 2, 10000);
        return null;
      }

      if (!res.ok) {
        this.stats.consecutiveErrors++;
        return null;
      }

      const data = (await res.json()) as JupiterQuoteResponse;
      if (!data.outAmount || !data.routePlan || data.routePlan.length === 0) {
        return null;
      }

      // Successful request resets backoff
      this.backoffDelayMs = 0;
      this.stats.consecutiveErrors = 0;
      this.stats.requestsSuccessful++;

      // Analyze route legs to determine if this route is composable (Metis /build) or RFQ indicative
      let isRfq = false;
      let primaryAmmKey = '';
      let primaryLabel = 'Jupiter';

      for (const leg of data.routePlan) {
        const label = leg.swapInfo.label;
        if (JupiterClient.RFQ_VENUES.has(label)) {
          isRfq = true;
        }
        if (!primaryAmmKey) {
          primaryAmmKey = leg.swapInfo.ammKey;
          primaryLabel = leg.swapInfo.label;
        }
      }

      const quoteSource: RouteCategory = isRfq
        ? 'JUPITER_ORDER_INDICATIVE'
        : 'JUPITER_BUILD_METIS';

      const executionType: ExecutionTag = isRfq
        ? 'INDICATIVE_ONLY'
        : 'POTENTIAL_ATOMIC';

      const dexType = this.mapLabelToDexType(primaryLabel);
      const priceImpactBps = Math.max(0, Math.round(parseFloat(data.priceImpactPct || '0') * 100));

      const quote: SwapQuote = {
        quoteSource,
        poolId: primaryAmmKey,
        dex: dexType,
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: BigInt(data.outAmount),
        feeIncluded: true,
        feeAmount: BigInt(0), // Already reflected in outAmount
        priceImpactBps,
        slot: data.contextSlot || 0,
        timestamp: Date.now(),
        executionType,
        rawRouteInfo: data.routePlan
      };

      this.quoteCache.set(cacheKey, { quote, cachedAt: Date.now() });
      return quote;
    } catch {
      this.stats.consecutiveErrors++;
      return null;
    }
  }

  private mapLabelToDexType(label: string): DexType {
    const l = label.toLowerCase();
    if (l.includes('raydium clmm')) return 'RAYDIUM_CLMM';
    if (l.includes('raydium cp')) return 'RAYDIUM_CPMM';
    if (l.includes('raydium')) return 'RAYDIUM_AMM';
    if (l.includes('whirlpool') || l.includes('orca')) return 'ORCA_WHIRLPOOL';
    if (l.includes('meteora dlmm')) return 'METEORA_DLMM';
    if (l.includes('meteora')) return 'METEORA_DAMM';
    if (l.includes('phoenix')) return 'PHOENIX';
    if (l.includes('openbook')) return 'OPENBOOK_V2';
    if (l.includes('zerofi')) return 'ZERO_FI';
    if (l.includes('humidifi')) return 'HUMIDI_FI';
    if (l.includes('solfi')) return 'SOL_FI';
    if (l.includes('pump')) return 'PUMP_FUN';
    return 'UNKNOWN';
  }

  public getStats(): JupiterClientStats {
    return { ...this.stats };
  }
}
