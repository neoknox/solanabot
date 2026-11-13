import { PoolState, FeedHealth } from '../types/index.js';
import { getTickArrayContentSignature } from '../dex/orcaTickArray.js';

export interface DedupeKey {
  route: string;
  amountUSDC: bigint;
  netProfitUSDC: string;
  stateVersion?: string;
}

export function getQuoteRelevantSignature(state: PoolState): string {
  const extra = (state.extraData || {}) as any;
  const basePart = `rA:${state.reserveA?.toString() ?? '0'},rB:${state.reserveB?.toString() ?? '0'},fee:${state.feeBps}`;
  if (state.dex === 'ORCA_WHIRLPOOL') {
    let tickArrayContent = '';
    if (extra.tickArrays) {
      const entries: [number, any][] = [];
      if (extra.tickArrays instanceof Map) {
        for (const [k, v] of extra.tickArrays.entries()) {
          entries.push([Number(k), v]);
        }
      } else {
        for (const [k, v] of Object.entries(extra.tickArrays)) {
          entries.push([Number(k), v]);
        }
      }
      entries.sort((a, b) => a[0] - b[0]);
      tickArrayContent = entries.map(([startIdx, arr]) => `${startIdx}:${getTickArrayContentSignature(arr)}`).join(';');
    }
    return `${basePart},p:${extra.sqrtPrice ?? '0'},t:${extra.tickCurrent ?? '0'},L:${extra.liquidity ?? '0'},ts:${extra.tickSpacing ?? '0'},ta:${tickArrayContent}`;
  }
  if (state.dex === 'RAYDIUM_AMM') {
    return `${basePart},ooB:${extra.openOrdersBaseTokenTotal ?? '0'},ooQ:${extra.openOrdersQuoteTokenTotal ?? '0'},ooSlot:${extra.openOrdersSlot ?? '0'},vASlot:${extra.vaultASlot ?? '0'},vBSlot:${extra.vaultBSlot ?? '0'}`;
  }
  return `${basePart},extra:${JSON.stringify(extra)}`;
}

export class StateCache {
  private poolStates = new Map<string, PoolState>();
  private dedupeCache = new Map<string, number>();
  private poolRevisions = new Map<string, number>();
  private lastQuoteStateSignatures = new Map<string, string>();
  private readonly dedupeWindowMs = 5000;

  public setPoolState(state: PoolState): { hasChanged: boolean; stateRevision: number } {
    const existing = this.poolStates.get(state.id);
    const newSig = getQuoteRelevantSignature(state);
    const prevSig = this.lastQuoteStateSignatures.get(state.id);

    let hasChanged = false;
    let rev = this.poolRevisions.get(state.id) || 1;
    if (!existing || prevSig !== newSig) {
      if (existing) {
        rev = rev + 1;
      }
      hasChanged = true;
      this.poolRevisions.set(state.id, rev);
      this.lastQuoteStateSignatures.set(state.id, newSig);
    }

    state.stateRevision = rev;
    this.poolStates.set(state.id, state);
    return { hasChanged, stateRevision: rev };
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
