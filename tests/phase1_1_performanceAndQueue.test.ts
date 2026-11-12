import { describe, it, expect } from 'vitest';
import { BoundedEventQueue } from '../src/scanner/eventQueue.js';
import { RaydiumAmmAdapter } from '../src/dex/raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from '../src/dex/orcaWhirlpoolAdapter.js';
import { PoolState } from '../src/types/index.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, KNOWN_PROGRAM_IDS } from '../src/config/index.js';

describe('Phase 1.1 Acceptance: Performance, Queue Overload & Burst Benchmarks', () => {
  it('Matrix P.1: BoundedEventQueue safely coalesces superseded updates for the same account', () => {
    const queue = new BoundedEventQueue(100);
    const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

    // Enqueue 10 updates with increasing slots for the same pool
    for (let slot = 100; slot < 110; slot++) {
      queue.enqueue({
        type: 'POOL_ACCOUNT',
        key: poolId,
        data: Buffer.alloc(752),
        slot,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });
    }

    // Since all 10 updates share the same key, coalescing keeps the queue size at 1
    expect(queue.size()).toBe(1);
    const stats = queue.getStats();
    expect(stats.coalescedCount).toBe(9);

    const dequeued = queue.dequeue();
    expect(dequeued).toBeDefined();
    // The coalesced update contains the latest slot (109)
    expect(dequeued!.slot).toBe(109);
  });

  it('Matrix P.2: BoundedEventQueue applies backpressure drops when exceeding maximum capacity', () => {
    const maxCapacity = 50;
    const queue = new BoundedEventQueue(maxCapacity);

    // Enqueue 80 updates with distinct keys
    for (let i = 0; i < 80; i++) {
      queue.enqueue({
        type: 'POOL_ACCOUNT',
        key: `pool-distinct-${i}`,
        data: Buffer.alloc(100),
        slot: 100 + i,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });
    }

    // Queue size never exceeds maxCapacity
    expect(queue.size()).toBe(maxCapacity);
    const stats = queue.getStats();
    expect(stats.droppedCount).toBe(30);
  });

  it('Matrix P.3: Burst account updates drain smoothly in FIFO order', () => {
    const queue = new BoundedEventQueue(500);

    for (let i = 0; i < 200; i++) {
      queue.enqueue({
        type: 'VAULT_ACCOUNT',
        key: `vault-${i}`,
        data: Buffer.alloc(72),
        slot: 500,
        receivedAtMs: Date.now(),
        monotonicReceiptTime: performance.now()
      });
    }

    expect(queue.size()).toBe(200);
    const drained = queue.drainAll();
    expect(drained.length).toBe(200);
    expect(queue.isEmpty()).toBe(true);
    expect(drained[0].key).toBe('vault-0');
    expect(drained[199].key).toBe('vault-199');
  });

  it('Matrix P.4: Local quote calculation achieves high throughput without external I/O', () => {
    const adapter = new RaydiumAmmAdapter();
    const pool: PoolState = {
      id: 'perf-pool',
      dex: 'RAYDIUM_AMM',
      programId: KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4,
      tokenAMint: CANONICAL_WSOL_MINT,
      tokenBMint: CANONICAL_USDC_MINT,
      tokenADecimals: 9,
      tokenBDecimals: 6,
      reserveA: 100000n * 1000000000n,
      reserveB: 8500000n * 1000000n,
      feeBps: 25,
      slot: 100,
      receivedAt: Date.now(),
      liquidityUsd: 17000000,
      feedHealth: 'HEALTHY'
    };

    const iterations = 50000;
    const inputAmount = 1000n * 1000000n; // $1,000 USDC

    const startTime = performance.now();
    for (let i = 0; i < iterations; i++) {
      const quote = adapter.quoteExactInput(pool, CANONICAL_USDC_MINT, inputAmount);
      if (!quote) throw new Error('Quote failed');
    }
    const elapsedMs = performance.now() - startTime;
    const quotesPerSec = Math.round((iterations / elapsedMs) * 1000);

    // Local in-memory quote calculation must exceed 100,000 quotes/second
    expect(quotesPerSec).toBeGreaterThan(100000);
    expect(elapsedMs).toBeLessThan(500); // 50k quotes under 500ms
  });
});
