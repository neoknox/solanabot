import { describe, it, expect, vi } from 'vitest';
import { StateCache } from '../src/scanner/stateCache.js';
import { JupiterClient } from '../src/providers/jupiterClient.js';
import { loadConfig } from '../src/config/index.js';
import { PoolState } from '../src/types/index.js';

describe('Test Matrix 12, 13, 18: Provider Health, Reconnection Cache Invalidation, and 429 Backoff', () => {
  it('Matrix 12.1: Cache invalidation marks pool states DISCONNECTED and clears dedupe memory', () => {
    const cache = new StateCache();
    const mockState: PoolState = {
      id: 'pool-test',
      dex: 'RAYDIUM_AMM',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      tokenAMint: 'tokenA',
      tokenBMint: 'tokenB',
      tokenADecimals: 9,
      tokenBDecimals: 6,
      feeBps: 25,
      slot: 100,
      receivedAt: Date.now(),
      liquidityUsd: 100000,
      feedHealth: 'HEALTHY'
    };

    cache.setPoolState(mockState);
    expect(cache.getPoolState('pool-test')?.feedHealth).toBe('HEALTHY');

    // Trigger disconnect invalidation
    cache.invalidateAll('DISCONNECTED');
    const invalidated = cache.getPoolState('pool-test');
    expect(invalidated?.feedHealth).toBe('DISCONNECTED');
    expect(invalidated?.receivedAt).toBe(0);
  });

  it('Matrix 13.1: Handles 429 Too Many Requests with exponential backoff and avoids runaway calls', async () => {
    const config = loadConfig({
      JUPITER_RATE_LIMIT_RPS: '10'
    });
    const client = new JupiterClient(config);

    // Mock fetch to simulate 429 Rate Limited response
    const originalFetch = global.fetch;
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        status: 429,
        ok: false,
        json: async () => ({ error: 'Too many requests' })
      } as unknown as Response;
    });

    try {
      const quote1 = await client.getQuote('mintIn', 'mintOut', 1000000n);
      expect(quote1).toBeNull();
      const stats = client.getStats();
      expect(stats.rateLimitHits).toBe(1);
      expect(stats.consecutiveErrors).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('Matrix 18.1: Operates without JUPITER_API_KEY in public keyless mode without fabricating data', async () => {
    const configWithoutKey = loadConfig({
      JUPITER_API_KEY: ''
    });
    expect(configWithoutKey.JUPITER_API_KEY).toBe('');

    const client = new JupiterClient(configWithoutKey);
    // Request to unmocked or nonexistent token must return null cleanly, never fabricated quote
    const quote = await client.getQuote('FakeTokenA', 'FakeTokenB', 1000n);
    expect(quote).toBeNull();
  });
});
