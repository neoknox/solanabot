import { PoolState, FeedHealth } from '../types/index.js';

export interface DedupeKey {
  route: string;
  amountUSDC: bigint;
  netProfitUSDC: string;
  stateVersion?: string;
}

export class StateCache {
  private poolStates = new Map<string, PoolState>();
  private dedupeCache = new Map<string, number>();
  private poolRevisions = new Map<string, number>();
  private readonly dedupeWindowMs = 5000;

  public setPoolState(state: PoolState): void {
    const rev = (this.poolRevisions.get(state.id) || 0) + 1;
    this.poolRevisions.set(state.id, rev);
    state.stateRevision = rev;
    this.poolStates.set(state.id, state);
  }

  public getPoolState(poolId: string): PoolState | undefined {
    return this.poolStates.get(poolId);
  }

  public getAllPoolStates(): PoolState[] {
    return Array.from(this.poolStates.values());
  }

  public invalidatePool(poolId: string, reason: FeedHealth = 'DEGRADED'): void {
    const state = this.poolStates.get(poolId);
    if (state) {
      state.feedHealth = reason;
      state.receivedAt = 0;
    }
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
    const versionPart = key.stateVersion ? `v:${key.stateVersion}` : `net:${key.netProfitUSDC}`;
    const serialized = `${key.route}:${versionPart}:${key.amountUSDC.toString()}`;
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
