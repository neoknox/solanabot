import {
  OpportunityWindow,
  OpportunityWindowStatus,
  WindowClosureReason,
  WindowObservation,
  NearMissRecord,
  StudySessionRecord,
  DurationPercentiles,
  StudyTelemetry,
  ArbitrageCandidate,
  PermanentRouteRecord,
  HourlyProfitabilityBucket,
  MostActiveHourSummary
} from '../types/index.js';
import { ArbitrageRepository } from '../storage/repository.js';

export function formatQatarTime(epochMs: number, includeMs = true): string {
  const d = new Date(epochMs);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Qatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(d);
  const partMap: Record<string, string> = {};
  for (const p of parts) partMap[p.type] = p.value;
  const base = `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;
  if (includeMs) {
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
    return `${base}.${ms} AST`;
  }
  return `${base} AST`;
}

export function formatQatarHour(epochMs: number): string {
  const d = new Date(epochMs);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Qatar',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return `${formatter.format(d)} AST`;
}

export interface OpportunityWindowTrackerOptions {
  sessionId?: string;
  targetDurationMs?: number; // Default 24 hours (86,400,000 ms)
  profitHurdleUSDC?: number; // Default 0.10 USDC
  quoteExpiryMs?: number;    // Default 2500 ms
  repository?: ArbitrageRepository;
  autoStart?: boolean;
}

export class OpportunityWindowTracker {
  private sessionId: string;
  private targetDurationMs: number;
  private profitHurdleUSDC: number;
  private quoteExpiryMs: number;
  private repository?: ArbitrageRepository;
  private isActive: boolean;

  private startedAt: number;
  private status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' = 'RUNNING';

  // Open windows keyed by `${routeId}:${tradeSizeUSDC}`
  private openWindows = new Map<string, OpportunityWindow>();

  // Completed or censored windows
  private closedWindows: OpportunityWindow[] = [];

  // Near-miss records (bounded buffer)
  private nearMisses: NearMissRecord[] = [];
  private static readonly MAX_NEAR_MISSES = 500;

  // Uptime tracking
  private healthyUptimeMs = 0;
  private feedDowntimeMs = 0;
  private disconnectCount = 0;
  private lastUptimeCheck: number;
  private lastFeedHealthy = true;

  // Hourly tracking buckets (0..23)
  private hourlyUptimeMs = new Array(24).fill(0);
  private hourlyDowntimeMs = new Array(24).fill(0);
  private hourlyDisconnectCount = new Array(24).fill(0);

  // Aggregate counters
  private totalObservedShadowOpportunities = 0;
  private totalQualifiedWindowsCount = 0;
  private revalidationSurvivedCount = 0;
  private revalidationDecayedCount = 0;

  // Hurdle history tracking
  private hurdleHistory: Array<{ hurdleUSDC: number; effectiveFromMs: number }> = [];

  constructor(options?: OpportunityWindowTrackerOptions) {
    this.sessionId = options?.sessionId || `study_${Date.now()}`;
    this.targetDurationMs = options?.targetDurationMs ?? 24 * 60 * 60 * 1000;
    this.profitHurdleUSDC = options?.profitHurdleUSDC ?? 0.10;
    this.quoteExpiryMs = options?.quoteExpiryMs ?? 2500;
    this.repository = options?.repository;
    this.isActive = options?.autoStart ?? true;

    this.startedAt = Date.now();
    this.lastUptimeCheck = Date.now();
    this.hurdleHistory.push({
      hurdleUSDC: this.profitHurdleUSDC,
      effectiveFromMs: this.startedAt
    });

    // Persist initial session record if repository provided and study is active
    if (this.isActive) {
      this.saveSession();
    }
  }

  public isStudyActive(): boolean {
    return this.isActive;
  }

  public startStudy(sessionId?: string): void {
    this.isActive = true;
    this.status = 'RUNNING';
    this.startedAt = Date.now();
    this.lastUptimeCheck = Date.now();
    if (sessionId) this.sessionId = sessionId;
    this.saveSession();
  }

  public stopStudy(): void {
    if (!this.isActive) return;
    this.completeStudy('SCANNER_STOP');
    this.isActive = false;
  }

  public getProfitHurdle(): number {
    return this.profitHurdleUSDC;
  }

  public getHurdleHistory(): Array<{ hurdleUSDC: number; effectiveFromMs: number }> {
    return [...this.hurdleHistory];
  }

  public setProfitHurdle(newHurdle: number, now = Date.now()): void {
    if (this.profitHurdleUSDC === newHurdle) return;
    const oldHurdle = this.profitHurdleUSDC;
    this.profitHurdleUSDC = newHurdle;
    this.hurdleHistory.push({
      hurdleUSDC: newHurdle,
      effectiveFromMs: now
    });

    // If new hurdle is higher, close any open windows whose peak conservative net is below new hurdle
    if (newHurdle > oldHurdle) {
      const monotonicNow = typeof performance !== 'undefined' ? performance.now() : now;
      for (const [key, window] of this.openWindows.entries()) {
        if (window.netProfitPeakUSDC < newHurdle) {
          this.closeWindow(
            window,
            key,
            WindowClosureReason.TARGET_SHORTFALL,
            now,
            window.lastObservedSlot,
            monotonicNow,
            window.netProfitMinUSDC
          );
        }
      }
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getStartedAt(): number {
    return this.startedAt;
  }

  public getStatus(): 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' {
    return this.status;
  }

  public setStatus(status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED'): void {
    this.status = status;
    this.saveSession();
  }

  /**
   * Called on every candidate evaluation for a specific route and trade size.
   */
  public recordEvaluation(
    candidate: ArbitrageCandidate,
    route?: PermanentRouteRecord,
    currentSlot = 0,
    isWsConnected = true,
    isRpcActive = true,
    nowOverride?: number
  ): void {
    const tradeSize = Number(candidate.inputAmountUSDC) / 1e6;
    const windowKey = `${candidate.routeName}:${tradeSize}`;
    const now = nowOverride !== undefined ? nowOverride : Date.now();
    const monotonicNow = nowOverride !== undefined ? nowOverride : (typeof performance !== 'undefined' ? performance.now() : now);
    const conservativeNet = parseFloat(candidate.minConservativeNetUSDC);
    const expectedNet = parseFloat(candidate.expectedNetUSDC);

    // Keep feed uptime tracked
    this.updateFeedUptime(isWsConnected, isRpcActive, now);

    // Track total shadow opportunities observed
    this.totalObservedShadowOpportunities++;

    const isQualified = candidate.status === 'QUALIFIED_SHADOW' &&
      candidate.survivalStatus !== 'DECAYED' &&
      conservativeNet >= this.profitHurdleUSDC;

    // Check if there is an existing open window for this route & size
    const existingWindow = this.openWindows.get(windowKey);

    if (isQualified) {
      if (!existingWindow) {
        // Open a new opportunity window
        const tokenMint = route?.orderedTokens?.[1] || candidate.leg1Quote.outputMint || 'UNKNOWN_MINT';
        const tokenSymbol = this.extractTokenSymbol(candidate.routeName, tokenMint);
        const buyDex = candidate.leg1Quote.dex || 'RAYDIUM';
        const buyPoolId = candidate.leg1Quote.poolId;
        const sellDex = candidate.leg2Quote.dex || 'ORCA';
        const sellPoolId = candidate.leg2Quote.poolId;

        const newWindow: OpportunityWindow = {
          windowId: `win_${this.sessionId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          sessionId: this.sessionId,
          routeId: candidate.routeName,
          tokenMint,
          tokenSymbol,
          buyDex,
          buyPoolId,
          sellDex,
          sellPoolId,
          tradeSizeUSDC: tradeSize,
          status: 'OPEN',
          closureReason: 'STILL_OPEN',
          isCensored: false,
          revalidationStatus: candidate.survivalStatus === 'SURVIVED' ? 'SURVIVED' : 'UNCHECKED',
          firstObservedAt: now,
          firstObservedSlot: currentSlot || candidate.leg1Quote.slot || 0,
          firstObservedMonotonic: monotonicNow,
          lastObservedAt: now,
          lastObservedSlot: currentSlot || candidate.leg1Quote.slot || 0,
          lastObservedMonotonic: monotonicNow,
          durationLowerBoundMs: 0,
          observedDurationMs: 0,
          closureIntervalMs: undefined,
          netProfitOpeningUSDC: conservativeNet,
          netProfitPeakUSDC: conservativeNet,
          netProfitMinUSDC: conservativeNet,
          observationCount: 1,
          lastStateVersion: candidate.stateVersion,
          historyObservations: [{
            timestamp: now,
            slot: currentSlot || candidate.leg1Quote.slot || 0,
            conservativeNetUSDC: conservativeNet,
            expectedNetUSDC: expectedNet,
            stateVersion: candidate.stateVersion
          }]
        };

        this.openWindows.set(windowKey, newWindow);
        this.totalQualifiedWindowsCount++;
        if (candidate.survivalStatus === 'SURVIVED') {
          this.revalidationSurvivedCount++;
        }

        if (this.repository) {
          try {
            this.repository.saveOpportunityWindow(newWindow);
          } catch {}
        }
      } else {
        // Existing window continues. Check for deduplication of unchanged market state
        const isDuplicateSnapshot = candidate.stateVersion &&
          candidate.stateVersion === existingWindow.lastStateVersion &&
          currentSlot === existingWindow.lastObservedSlot;

        if (isDuplicateSnapshot) {
          // Do not artificially lengthen window duration on duplicate snapshots of unchanged market state.
          // Touch timestamp prevents premature quote expiry without inflating observed duration.
          existingWindow.lastTouchedAt = now;
        } else {
          // Genuine state update while remaining qualified
          existingWindow.observationCount++;
          existingWindow.lastObservedAt = now;
          existingWindow.lastTouchedAt = now;
          existingWindow.lastObservedSlot = currentSlot || candidate.leg1Quote.slot || existingWindow.lastObservedSlot;
          existingWindow.lastObservedMonotonic = monotonicNow;
          const obsDur = Math.max(0, Math.round(monotonicNow - existingWindow.firstObservedMonotonic));
          existingWindow.durationLowerBoundMs = obsDur;
          existingWindow.observedDurationMs = obsDur;
          existingWindow.netProfitPeakUSDC = Math.max(existingWindow.netProfitPeakUSDC, conservativeNet);
          existingWindow.netProfitMinUSDC = Math.min(existingWindow.netProfitMinUSDC, conservativeNet);
          existingWindow.lastStateVersion = candidate.stateVersion;

          if (candidate.survivalStatus === 'SURVIVED' && existingWindow.revalidationStatus !== 'SURVIVED') {
            existingWindow.revalidationStatus = 'SURVIVED';
            this.revalidationSurvivedCount++;
          }

          if (existingWindow.historyObservations.length < 50) {
            existingWindow.historyObservations.push({
              timestamp: now,
              slot: currentSlot || candidate.leg1Quote.slot || existingWindow.lastObservedSlot,
              conservativeNetUSDC: conservativeNet,
              expectedNetUSDC: expectedNet,
              stateVersion: candidate.stateVersion
            });
          }

          if (this.repository) {
            try {
              this.repository.saveOpportunityWindow(existingWindow);
            } catch {}
          }
        }
      }
    } else {
      // Not qualified. If there is an existing window, close it with appropriate reason
      if (existingWindow) {
        const closureReason = this.determineClosureReason(candidate, conservativeNet, expectedNet, isWsConnected, isRpcActive);
        this.closeWindow(existingWindow, windowKey, closureReason, now, currentSlot, monotonicNow, conservativeNet);
      }

      // Record near miss if expected or conservative net > 0 but below hurdle
      if (conservativeNet > 0 || expectedNet > 0) {
        this.recordNearMiss(candidate, tradeSize, expectedNet, conservativeNet, now, currentSlot);
      }
    }
  }

  /**
   * Determine exact closure reason from candidate state and connection status.
   */
  private determineClosureReason(
    candidate: ArbitrageCandidate,
    conservativeNet: number,
    expectedNet: number,
    isWsConnected: boolean,
    isRpcActive: boolean
  ): WindowClosureReason {
    if (!isWsConnected || !isRpcActive) {
      return WindowClosureReason.UNKNOWN;
    }

    if (candidate.survivalStatus === 'DECAYED') {
      return WindowClosureReason.REVALIDATION_FAILURE;
    }

    if (candidate.rejectionReasons?.includes('STALE_QUOTE') ||
        candidate.rejectionReasons?.includes('SLOT_MISMATCH') ||
        candidate.rejectionReasons?.includes('OBSERVATION_EXPIRED')) {
      return WindowClosureReason.STALE_MARKET_STATE;
    }

    if (candidate.rejectionReasons?.includes('EXCESSIVE_PRICE_IMPACT')) {
      return WindowClosureReason.PRICE_IMPACT_BREACH;
    }

    if (candidate.rejectionReasons?.includes('INSUFFICIENT_LIQUIDITY')) {
      return WindowClosureReason.LIQUIDITY_DROP;
    }

    if (candidate.rejectionReasons?.includes('QUOTE_UNVERIFIED') ||
        candidate.rejectionReasons?.includes('UNSUPPORTED_ROUTE')) {
      return WindowClosureReason.ROUTE_BLOCKED;
    }

    // Spread and net profit checks
    if (expectedNet <= 0) {
      return WindowClosureReason.SPREAD_COMPRESSION;
    }

    if (conservativeNet < this.profitHurdleUSDC) {
      return WindowClosureReason.TARGET_SHORTFALL;
    }

    return WindowClosureReason.TARGET_SHORTFALL;
  }

  /**
   * Close an open window and persist it.
   */
  private closeWindow(
    window: OpportunityWindow,
    windowKey: string,
    reason: WindowClosureReason | string,
    closedAt: number,
    closedAtSlot: number,
    closedAtMonotonic: number,
    closingNet?: number
  ): void {
    this.openWindows.delete(windowKey);

    const isCensored = reason === WindowClosureReason.QUOTE_EXPIRED ||
      reason === WindowClosureReason.STALE_MARKET_STATE ||
      reason === WindowClosureReason.WS_DISCONNECTED ||
      reason === WindowClosureReason.RPC_FAILURE ||
      reason === WindowClosureReason.SCANNER_STOP ||
      reason === WindowClosureReason.STUDY_COMPLETED ||
      reason === WindowClosureReason.UNKNOWN;

    window.status = isCensored ? 'INTERRUPTED_CENSORED' : 'CLOSED';
    window.closureReason = reason;
    window.isCensored = isCensored;
    window.closedAt = closedAt;
    window.closedAtSlot = closedAtSlot;
    window.closedAtMonotonic = closedAtMonotonic;
    window.observedDurationMs = Math.max(0, Math.round(window.lastObservedMonotonic - window.firstObservedMonotonic));
    window.closureIntervalMs = Math.max(0, Math.round(closedAtMonotonic - window.lastObservedMonotonic));
    window.durationUpperBoundMs = Math.max(0, Math.round(closedAtMonotonic - window.firstObservedMonotonic));
    window.durationLowerBoundMs = window.observedDurationMs;
    window.netProfitClosingUSDC = closingNet;

    if (window.revalidationStatus === 'UNCHECKED' && reason === WindowClosureReason.REVALIDATION_FAILURE) {
      window.revalidationStatus = 'DECAYED';
      this.revalidationDecayedCount++;
    }

    this.closedWindows.push(window);

    if (this.repository) {
      try {
        this.repository.saveOpportunityWindow(window);
      } catch {}
    }
  }

  /**
   * Check for windows that haven't received an update within quoteExpiryMs.
   */
  public purgeExpiredWindows(now = Date.now(), currentSlot = 0): void {
    const monotonicNow = typeof performance !== 'undefined' ? performance.now() : now;

    for (const [key, window] of this.openWindows.entries()) {
      const lastActive = window.lastTouchedAt || window.lastObservedAt;
      if (now - lastActive > this.quoteExpiryMs) {
        this.closeWindow(
          window,
          key,
          WindowClosureReason.QUOTE_EXPIRED,
          now,
          currentSlot,
          monotonicNow
        );
      }
    }
  }

  /**
   * Invoked when WebSocket disconnects. All open windows are closed as censored.
   */
  public onWebSocketDisconnect(now = Date.now(), currentSlot = 0): void {
    this.disconnectCount++;
    this.lastFeedHealthy = false;
    const monotonicNow = typeof performance !== 'undefined' ? performance.now() : now;

    const hourIdx = Math.min(23, Math.max(0, Math.floor((now - this.startedAt) / 3600000)));
    this.hourlyDisconnectCount[hourIdx] = (this.hourlyDisconnectCount[hourIdx] || 0) + 1;

    for (const [key, window] of this.openWindows.entries()) {
      this.closeWindow(
        window,
        key,
        WindowClosureReason.WS_DISCONNECTED,
        now,
        currentSlot,
        monotonicNow
      );
    }
    this.saveSession();
  }

  /**
   * Invoked when WebSocket reconnects.
   */
  public onWebSocketReconnect(now = Date.now()): void {
    this.lastFeedHealthy = true;
    this.saveSession();
  }

  /**
   * Track healthy uptime vs feed downtime and record hourly allocations.
   */
  public updateFeedUptime(isWsConnected: boolean, isRpcActive: boolean, now = Date.now()): void {
    const delta = Math.max(0, now - this.lastUptimeCheck);
    const prev = this.lastUptimeCheck;
    this.lastUptimeCheck = now;

    const isHealthy = isWsConnected && isRpcActive;
    if (isHealthy) {
      this.healthyUptimeMs += delta;
    } else {
      this.feedDowntimeMs += delta;
    }
    this.lastFeedHealthy = isHealthy;

    // Distribute delta across hourly buckets from prev to now
    let t = prev;
    while (t < now) {
      const relMs = Math.max(0, t - this.startedAt);
      const hourIdx = Math.min(23, Math.floor(relMs / 3600000));
      const nextHourStart = this.startedAt + (hourIdx + 1) * 3600000;
      const chunkEnd = Math.min(now, nextHourStart);
      const chunk = Math.max(0, chunkEnd - t);

      if (isHealthy) {
        this.hourlyUptimeMs[hourIdx] = (this.hourlyUptimeMs[hourIdx] || 0) + chunk;
      } else {
        this.hourlyDowntimeMs[hourIdx] = (this.hourlyDowntimeMs[hourIdx] || 0) + chunk;
      }
      t = chunkEnd;
      if (t >= nextHourStart && hourIdx >= 23) break;
    }
  }

  /**
   * Complete study (e.g. at 24h limit or on graceful shutdown).
   */
  public completeStudy(reason: 'STUDY_COMPLETED' | 'SCANNER_STOP' = 'STUDY_COMPLETED', now = Date.now(), currentSlot = 0): void {
    this.status = reason === 'STUDY_COMPLETED' ? 'COMPLETED' : 'INTERRUPTED';
    const monotonicNow = typeof performance !== 'undefined' ? performance.now() : now;

    // Close any remaining open windows as censored
    const closureReason = reason === 'STUDY_COMPLETED' ? WindowClosureReason.STUDY_COMPLETED : WindowClosureReason.SCANNER_STOP;
    for (const [key, window] of this.openWindows.entries()) {
      this.closeWindow(window, key, closureReason, now, currentSlot, monotonicNow);
    }

    this.saveSession(now);
  }

  /**
   * Record near miss without treating as qualified opportunity.
   */
  private recordNearMiss(
    candidate: ArbitrageCandidate,
    tradeSize: number,
    expectedNet: number,
    conservativeNet: number,
    now: number,
    slot: number
  ): void {
    const shortfall = Math.max(0, this.profitHurdleUSDC - conservativeNet);
    const tokenMint = candidate.leg1Quote.outputMint || 'UNKNOWN_MINT';
    const tokenSymbol = this.extractTokenSymbol(candidate.routeName, tokenMint);

    this.nearMisses.push({
      id: `nm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      routeId: candidate.routeName,
      tokenSymbol,
      tradeSizeUSDC: tradeSize,
      expectedNetUSDC: expectedNet,
      conservativeNetUSDC: conservativeNet,
      shortfallUSDC: shortfall,
      timestamp: now,
      slot
    });

    if (this.nearMisses.length > OpportunityWindowTracker.MAX_NEAR_MISSES) {
      this.nearMisses.shift();
    }
  }

  /**
   * Compute duration percentiles strictly from observed CLOSED windows (excluding censored).
   */
  public calculateDurationPercentiles(): DurationPercentiles {
    const closed = this.closedWindows.filter(w => w.status === 'CLOSED');
    if (closed.length === 0) {
      return {
        count: 0,
        minMs: 0,
        medianMs: 0,
        p95Ms: 0,
        maxMs: 0,
        under500msCount: 0,
        between500msAnd2sCount: 0,
        over2sCount: 0
      };
    }

    const durations = closed.map(w => w.durationUpperBoundMs ?? w.durationLowerBoundMs).sort((a, b) => a - b);
    const count = durations.length;
    const minMs = durations[0];
    const maxMs = durations[count - 1];
    const medianMs = durations[Math.floor(count / 2)];
    const p95Idx = Math.min(count - 1, Math.floor(count * 0.95));
    const p95Ms = durations[p95Idx];

    let under500msCount = 0;
    let between500msAnd2sCount = 0;
    let over2sCount = 0;

    for (const d of durations) {
      if (d < 500) {
        under500msCount++;
      } else if (d <= 2000) {
        between500msAnd2sCount++;
      } else {
        over2sCount++;
      }
    }

    return {
      count,
      minMs,
      medianMs,
      p95Ms,
      maxMs,
      under500msCount,
      between500msAnd2sCount,
      over2sCount
    };
  }

  /**
   * Compute 24-hour hourly profitability metrics across all 24 study hours.
   */
  public getHourlyProfitabilityBuckets(now = Date.now()): HourlyProfitabilityBucket[] {
    const allWindows = [...this.openWindows.values(), ...this.closedWindows];
    const buckets: HourlyProfitabilityBucket[] = [];

    for (let h = 0; h < 24; h++) {
      const hourStartMs = this.startedAt + h * 3600000;
      const hourEndMs = hourStartMs + 3600000;
      const hourStartUtc = new Date(hourStartMs).toISOString();
      const hourStartQatar = formatQatarTime(hourStartMs, true);
      const startQatar = formatQatarHour(hourStartMs);
      const endQatar = formatQatarHour(hourEndMs);
      const hourLabel = `Hour ${h} (${startQatar})`;
      const timeRangeQatar = `${startQatar} - ${endQatar}`;

      const uMs = this.hourlyUptimeMs[h] || 0;
      const dMs = this.hourlyDowntimeMs[h] || 0;
      const disc = this.hourlyDisconnectCount[h] || 0;
      const totalTracked = uMs + dMs;

      let healthyCoveragePct: number | null = null;
      let revalidationSuccessPct: number | null = null;

      // Collect windows active in this hour (opened during this hour)
      const windowsInHour = allWindows.filter(w => w.firstObservedAt >= hourStartMs && w.firstObservedAt < hourEndMs);
      const uniqueWindowsCount = windowsInHour.length;
      const bestConservativeNetUSDC = windowsInHour.reduce((max, w) => Math.max(max, w.netProfitPeakUSDC), 0.0);

      // Median observed duration strictly from closed windows in this hour
      const closedInHour = windowsInHour.filter(w => w.status === 'CLOSED');
      const durations = closedInHour.map(w => w.observedDurationMs).sort((a, b) => a - b);
      const medianObservedDurationMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0;

      // Revalidation success rate
      const survived = windowsInHour.filter(w => w.revalidationStatus === 'SURVIVED').length;
      const decayed = windowsInHour.filter(w => w.revalidationStatus === 'DECAYED').length;
      const totalReval = survived + decayed;

      let status: HourlyProfitabilityBucket['status'] = 'FUTURE';
      if (now < hourStartMs) {
        status = 'FUTURE';
        healthyCoveragePct = null;
        revalidationSuccessPct = null;
      } else {
        if (totalTracked > 0) {
          healthyCoveragePct = Number(((uMs / totalTracked) * 100).toFixed(1));
        } else if (dMs > 0) {
          healthyCoveragePct = 0.0;
        } else {
          healthyCoveragePct = null;
        }

        if (totalReval > 0) {
          revalidationSuccessPct = Number(((survived / totalReval) * 100).toFixed(1));
        } else {
          revalidationSuccessPct = null;
        }

        if (totalTracked > 0 && uMs === 0) {
          status = 'FEED_DISCONNECTED';
        } else if (dMs > 0 && (healthyCoveragePct !== null && healthyCoveragePct < 50.0)) {
          status = 'COVERAGE_DEGRADED';
        } else if (uniqueWindowsCount === 0) {
          status = 'NO_OPPORTUNITIES_VERIFIED';
        } else {
          status = 'ACTIVE_OBSERVED';
        }
      }

      buckets.push({
        hourIndex: h,
        hourStartUtc,
        hourStartQatar,
        hourLabel,
        timeRangeQatar,
        uniqueWindowsCount,
        bestConservativeNetUSDC,
        medianObservedDurationMs,
        revalidationSuccessPct,
        healthyCoveragePct,
        healthyUptimeMs: uMs,
        feedDowntimeMs: dMs,
        disconnectCount: disc,
        status
      });
    }

    return buckets;
  }

  /**
   * Identify the most active profitable hours based strictly on verified observations.
   * Disconnected periods are excluded from zero-opportunity conclusions.
   */
  public getMostActiveHours(now = Date.now()): MostActiveHourSummary[] {
    const buckets = this.getHourlyProfitabilityBuckets(now);
    // Filter to hours with active observed opportunities and healthy monitoring
    const verifiedBuckets = buckets.filter(b => b.status === 'ACTIVE_OBSERVED' && b.uniqueWindowsCount > 0);

    verifiedBuckets.sort((a, b) => {
      if (b.uniqueWindowsCount !== a.uniqueWindowsCount) {
        return b.uniqueWindowsCount - a.uniqueWindowsCount;
      }
      return b.bestConservativeNetUSDC - a.bestConservativeNetUSDC;
    });

    return verifiedBuckets.map((b, idx) => ({
      rank: idx + 1,
      hourIndex: b.hourIndex,
      hourLabel: b.hourLabel,
      timeRangeQatar: b.timeRangeQatar,
      uniqueWindowsCount: b.uniqueWindowsCount,
      bestConservativeNetUSDC: b.bestConservativeNetUSDC,
      medianObservedDurationMs: b.medianObservedDurationMs,
      healthyCoveragePct: b.healthyCoveragePct,
      status: b.status
    }));
  }

  /**
   * Generate telemetry payload for HUD and reporting.
   */
  public getTelemetry(now = Date.now()): StudyTelemetry {
    const elapsedMs = Math.max(0, now - this.startedAt);
    const percentiles = this.calculateDurationPercentiles();

    const allWindows = [...this.openWindows.values(), ...this.closedWindows];
    let bestConservativeNetUSDC = 0;
    for (const w of allWindows) {
      if (w.netProfitPeakUSDC > bestConservativeNetUSDC) {
        bestConservativeNetUSDC = w.netProfitPeakUSDC;
      }
    }

    const censoredCount = this.closedWindows.filter(w => w.status === 'INTERRUPTED_CENSORED').length;
    const completedCount = this.closedWindows.filter(w => w.status === 'CLOSED').length;

    const totalRevalChecked = this.revalidationSurvivedCount + this.revalidationDecayedCount;
    const revalidationSuccessPct = totalRevalChecked > 0
      ? Number(((this.revalidationSurvivedCount / totalRevalChecked) * 100).toFixed(1))
      : null;

    const liveWindows = Array.from(this.openWindows.values());
    const recentClosed = this.closedWindows.slice(-20).reverse();

    return {
      sessionId: this.sessionId,
      profitHurdleUSDC: this.profitHurdleUSDC,
      status: this.status,
      startedAt: this.startedAt,
      targetDurationMs: this.targetDurationMs,
      elapsedMs,
      healthyUptimeMs: this.healthyUptimeMs,
      feedDowntimeMs: this.feedDowntimeMs,
      disconnectCount: this.disconnectCount,
      totalQualifiedWindows: this.totalQualifiedWindowsCount,
      openQualifiedWindows: this.openWindows.size,
      completedQualifiedWindows: completedCount,
      censoredWindows: censoredCount,
      revalidationSuccessPct,
      minDurationMs: percentiles.minMs,
      medianDurationMs: percentiles.medianMs,
      p95DurationMs: percentiles.p95Ms,
      maxDurationMs: percentiles.maxMs,
      bestConservativeNetUSDC,
      totalObservedShadowOpportunities: this.totalObservedShadowOpportunities,
      liveWindows,
      closedWindows: recentClosed,
      nearMissesCount: this.nearMisses.length,
      hourlyBuckets: this.getHourlyProfitabilityBuckets(now),
      mostActiveHours: this.getMostActiveHours(now),
      activeHurdleHistory: this.getHurdleHistory()
    };
  }

  public getAllClosedWindows(): OpportunityWindow[] {
    return [...this.closedWindows];
  }

  public getAllOpenWindows(): OpportunityWindow[] {
    return Array.from(this.openWindows.values());
  }

  public getNearMisses(): NearMissRecord[] {
    return [...this.nearMisses];
  }

  private saveSession(endedAt?: number): void {
    if (!this.repository || (!this.isActive && endedAt === undefined)) return;
    try {
      const now = Date.now();
      const sessionRecord: StudySessionRecord = {
        sessionId: this.sessionId,
        startedAt: this.startedAt,
        endedAt: endedAt ?? (this.status !== 'RUNNING' ? now : undefined),
        status: this.status,
        targetDurationMs: this.targetDurationMs,
        healthyUptimeMs: this.healthyUptimeMs,
        feedDowntimeMs: this.feedDowntimeMs,
        disconnectCount: this.disconnectCount,
        totalWindowsCount: this.openWindows.size + this.closedWindows.length,
        qualifiedWindowsCount: this.totalQualifiedWindowsCount,
        nearMissesCount: this.nearMisses.length,
        createdAt: this.startedAt,
        updatedAt: now
      };
      this.repository.saveStudySession(sessionRecord);
    } catch {}
  }

  private extractTokenSymbol(routeName: string, tokenMint: string): string {
    const match = routeName.match(/^([A-Za-z0-9_]+)\s*(\(|$)/);
    if (match && match[1] && match[1] !== 'USDC') {
      return match[1];
    }
    const arrowMatch = routeName.match(/USDC\s*->\s*([A-Za-z0-9_]+)\s*->/i);
    if (arrowMatch && arrowMatch[1]) {
      return arrowMatch[1];
    }
    return tokenMint.length > 8 ? `${tokenMint.substring(0, 4)}...${tokenMint.substring(tokenMint.length - 4)}` : tokenMint;
  }
}
