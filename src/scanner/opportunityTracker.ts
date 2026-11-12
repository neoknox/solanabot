import { ArbitrageCandidate } from '../types/index.js';

export interface ActiveOpportunityRecord {
  opportunityId: string;
  routeKey: string;
  firstSeenTimestamp: number;
  firstSeenSlot: number;
  lastSeenTimestamp: number;
  lastSeenSlot: number;
  lastStateVersion?: string;
  sizeUSDC: number;
  visibilityDurationMs: number;
  observedSnapshotsCount: number;
  lastConservativeNetUSDC: string;
  status: string;
}

export interface OpportunityLifecycleStats {
  totalTrackedOpportunities: number;
  activeOpportunitiesCount: number;
  meanVisibilityDurationMs: number;
  maxVisibilityDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

export class OpportunityTracker {
  private opportunities = new Map<string, ActiveOpportunityRecord>();
  private completedLifecycles: ActiveOpportunityRecord[] = [];
  private static readonly MAX_COMPLETED = 5000;

  /**
   * Tracks visibility duration across sequential snapshots
   */
  public trackOpportunity(candidate: ArbitrageCandidate, currentSlot: number): {
    visibilityDurationMs: number;
    observedSnapshotsCount: number;
  } {
    const inputSize = candidate.optimalSizeUSDC || Number(candidate.inputAmountUSDC) / 1e6;
    const poolKeys = [candidate.leg1Quote.poolId, candidate.leg2Quote.poolId, candidate.leg3Quote?.poolId]
      .filter(Boolean)
      .join('->');
    const routeKey = `${poolKeys}:${inputSize.toFixed(0)}`;

    const now = candidate.timestamp || Date.now();
    let record = this.opportunities.get(routeKey);

    if (record) {
      const slotChanged = currentSlot !== record.lastSeenSlot;
      record.lastSeenTimestamp = now;
      record.lastSeenSlot = currentSlot;
      record.visibilityDurationMs = Math.max(0, record.lastSeenTimestamp - record.firstSeenTimestamp);
      // Track persistence strictly across NEW independently observed pool states;
      // repeated recalculation of the same snapshot does not count as survival.
      if (candidate.stateVersion) {
        if (candidate.stateVersion !== record.lastStateVersion) {
          record.observedSnapshotsCount += 1;
          record.lastStateVersion = candidate.stateVersion;
        }
      } else if (slotChanged) {
        record.observedSnapshotsCount += 1;
      }
      record.sizeUSDC = inputSize;
      record.lastConservativeNetUSDC = candidate.minConservativeNetUSDC;
      record.status = candidate.status;
    } else {
      record = {
        opportunityId: candidate.candidateId,
        routeKey,
        firstSeenTimestamp: now,
        firstSeenSlot: currentSlot,
        lastSeenTimestamp: now,
        lastSeenSlot: currentSlot,
        lastStateVersion: candidate.stateVersion,
        sizeUSDC: inputSize,
        visibilityDurationMs: 0,
        observedSnapshotsCount: 1,
        lastConservativeNetUSDC: candidate.minConservativeNetUSDC,
        status: candidate.status
      };
      this.opportunities.set(routeKey, record);
    }

    candidate.visibilityDurationMs = record.visibilityDurationMs;
    candidate.observedSnapshotsCount = record.observedSnapshotsCount;

    return {
      visibilityDurationMs: record.visibilityDurationMs,
      observedSnapshotsCount: record.observedSnapshotsCount
    };
  }

  /**
   * Cleans up stale opportunities not seen in the latest scan cycles
   */
  public purgeStaleOpportunities(maxAgeMs = 10000): void {
    const now = Date.now();
    for (const [key, record] of this.opportunities.entries()) {
      if (now - record.lastSeenTimestamp > maxAgeMs) {
        if (this.completedLifecycles.length >= OpportunityTracker.MAX_COMPLETED) {
          this.completedLifecycles.shift();
        }
        this.completedLifecycles.push(record);
        this.opportunities.delete(key);
      }
    }
  }

  public getLifecycleStats(): OpportunityLifecycleStats {
    const allRecords = [...this.opportunities.values(), ...this.completedLifecycles];
    if (allRecords.length === 0) {
      return {
        totalTrackedOpportunities: 0,
        activeOpportunitiesCount: 0,
        meanVisibilityDurationMs: 0,
        maxVisibilityDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0
      };
    }

    const durations = allRecords.map(r => r.visibilityDurationMs).sort((a, b) => a - b);
    const count = durations.length;
    const maxVisibilityDurationMs = durations[count - 1];
    const sum = durations.reduce((a, b) => a + b, 0);
    const meanVisibilityDurationMs = Math.round(sum / count);
    const p50DurationMs = durations[Math.floor(count * 0.50)];
    const p95DurationMs = durations[Math.floor(count * 0.95)] || maxVisibilityDurationMs;

    return {
      totalTrackedOpportunities: allRecords.length,
      activeOpportunitiesCount: this.opportunities.size,
      meanVisibilityDurationMs,
      maxVisibilityDurationMs,
      p50DurationMs,
      p95DurationMs
    };
  }

  public getAllActiveOpportunities(): ActiveOpportunityRecord[] {
    return Array.from(this.opportunities.values());
  }

  public getActiveOpportunity(routeKey: string): ActiveOpportunityRecord | undefined {
    return this.opportunities.get(routeKey);
  }

  public getActiveAllocatedCapital(): number {
    let total = 0;
    for (const record of this.opportunities.values()) {
      if (record.status === 'QUALIFIED_SHADOW') {
        total += record.sizeUSDC || 0;
      }
    }
    return total;
  }
}
