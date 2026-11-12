import { PoolState, FeedHealth } from '../types/index.js';

export interface DedupeKey {
  route: string;
  amountUSDC: bigint;
  netProfitUSDC: string;
}

export class StateCache {
  private poolStates = new Map<string, PoolState>();
  private dedupeCache = new Map<string, number>();
  private readonly dedupeWindowMs = 5000;

  public setPoolState(state: PoolState): void {
    this.poolStates.set(state.id, state);
  }

  public getPoolState(poolId: string): PoolState | undefined {
    return this.poolStates.get(poolId);
  }

  public getAllPoolStates(): PoolState[] {
    return Array.from(this.poolStates.values());
  }

  public invalidateAll(reason: FeedHealth = 'DISCONNECTED'): void {
    for (const [id, state] of this.poolStates.entries()) {
      this.poolStates.set(id, {
        ...state,
        feedHealth: reason,
        receivedAt: 0
      });
    }
    this.dedupeCache.clear();
  }

  public isDuplicate(key: DedupeKey): boolean {
    const serialized = `${key.route}:${key.amountUSDC.toString()}:${key.netProfitUSDC}`;
    const now = Date.now();
    const lastSeen = this.dedupeCache.get(serialized);

    if (lastSeen && (now - lastSeen) < this.dedupeWindowMs) {
      return true;
    }

    this.dedupeCache.set(serialized, now);
    this.cleanupDedupeCache(now);
    return false;
  }

  private cleanupDedupeCache(now: number): void {
    if (this.dedupeCache.size > 2000) {
      for (const [key, timestamp] of this.dedupeCache.entries()) {
        if (now - timestamp > this.dedupeWindowMs) {
          this.dedupeCache.delete(key);
        }
      }
    }
  }

  public clear(): void {
    this.poolStates.clear();
    this.dedupeCache.clear();
  }
}
