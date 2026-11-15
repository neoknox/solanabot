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
  PermanentRouteRecord
} from '../types/index.js';
import { ArbitrageRepository } from '../storage/repository.js';

export interface OpportunityWindowTrackerOptions {
  sessionId?: string;
  targetDurationMs?: number; // Default 24 hours (86,400,000 ms)
  profitHurdleUSDC?: number; // Default 0.50 USDC
  quoteExpiryMs?: number;    // Default 2500 ms
  repository?: ArbitrageRepository;
}

export class OpportunityWindowTracker {
  private sessionId: string;
  private targetDurationMs: number;
  private profitHurdleUSDC: number;
  private quoteExpiryMs: number;
  private repository?: ArbitrageRepository;

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

  // Aggregate counters
  private totalObservedShadowOpportunities = 0;
  private totalQualifiedWindowsCount = 0;
  private revalidationSurvivedCount = 0;
  private revalidationDecayedCount = 0;

  constructor(options?: OpportunityWindowTrackerOptions) {
    this.sessionId = options?.sessionId || `study_${Date.now()}`;
    this.targetDurationMs = options?.targetDurationMs ?? 24 * 60 * 60 * 1000;
    this.profitHurdleUSDC = options?.profitHurdleUSDC ?? 0.50;
    this.quoteExpiryMs = options?.quoteExpiryMs ?? 2500;
    this.repository = options?.repository;

    this.startedAt = Date.now();
    this.lastUptimeCheck = Date.now();

    // Persist initial session record if repository provided
    this.saveSession();
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
    isRpcActive = true
  ): void {
    const tradeSize = Number(candidate.inputAmountUSDC) / 1e6;
    const windowKey = `${candidate.routeName}:${tradeSize}`;
    const now = Date.now();
    const monotonicNow = typeof performance !== 'undefined' ? performance.now() : now;
    const conservativeNet = parseFloat(candidate.minConservativeNetUSDC);
    const expectedNet = parseFloat(candidate.expectedNetUSDC);

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
          // Just update monotonic time without duplicating observations
          existingWindow.lastObservedAt = now;
          existingWindow.lastObservedMonotonic = monotonicNow;
        } else {
          // Genuine state update while remaining qualified
          existingWindow.observationCount++;
          existingWindow.lastObservedAt = now;
          existingWindow.lastObservedSlot = currentSlot || candidate.leg1Quote.slot || existingWindow.lastObservedSlot;
          existingWindow.lastObservedMonotonic = monotonicNow;
          existingWindow.durationLowerBoundMs = Math.max(0, Math.round(monotonicNow - existingWindow.firstObservedMonotonic));
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
    if (!isWsConnected) return WindowClosureReason.WS_DISCONNECTED;
    if (!isRpcActive) return WindowClosureReason.RPC_FAILURE;

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
      reason === WindowClosureReason.STUDY_COMPLETED;

    window.status = isCensored ? 'INTERRUPTED_CENSORED' : 'CLOSED';
    window.closureReason = reason;
    window.isCensored = isCensored;
    window.closedAt = closedAt;
    window.closedAtSlot = closedAtSlot;
    window.closedAtMonotonic = closedAtMonotonic;
    window.durationUpperBoundMs = Math.max(0, Math.round(closedAtMonotonic - window.firstObservedMonotonic));
    window.durationLowerBoundMs = Math.max(0, Math.round(window.lastObservedMonotonic - window.firstObservedMonotonic));
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
      if (now - window.lastObservedAt > this.quoteExpiryMs) {
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
   * Track healthy uptime vs feed downtime.
   */
  public updateFeedUptime(isWsConnected: boolean, isRpcActive: boolean, now = Date.now()): void {
    const delta = Math.max(0, now - this.lastUptimeCheck);
    this.lastUptimeCheck = now;

    const isHealthy = isWsConnected && isRpcActive;
    if (isHealthy) {
      this.healthyUptimeMs += delta;
    } else {
      this.feedDowntimeMs += delta;
    }
    this.lastFeedHealthy = isHealthy;
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
      ? (this.revalidationSurvivedCount / totalRevalChecked) * 100
      : 100.0;

    const liveWindows = Array.from(this.openWindows.values());
    const recentClosed = this.closedWindows.slice(-20).reverse();

    return {
      sessionId: this.sessionId,
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
      nearMissesCount: this.nearMisses.length
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
    if (!this.repository) return;
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
    // Route names typically look like: "SOL (Raydium -> Orca)" or "USDC -> JUP -> USDC"
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
