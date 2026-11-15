export interface PercentileStats {
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export interface PipelineStages {
  t0: number;            // WebSocket receipt monotonic timestamp
  tDequeue?: number;     // Monotonic timestamp when update was dequeued from eventQueue
  t1: number;            // Decoded & validated monotonic timestamp
  t2: number;            // Shared stateCache updated monotonic timestamp
  tLookupStart?: number; // Monotonic timestamp when route lookup began
  t3: number;            // Affected 2-leg routes identified monotonic timestamp (captured AFTER lookup)
  tEvalStart?: number;   // Monotonic timestamp when route evaluation began
  t4: number;            // Multi-leg quotes calculated monotonic timestamp
  t5: number;            // Conservative net profit calculated monotonic timestamp
  t6?: number;           // Actual qualified shadow signal emitted monotonic timestamp (ONLY if qualified)
  t7?: number;           // Immediate revalidation completed monotonic timestamp (ONLY if revalidated)
  isQualified?: boolean; // Whether opportunity met conservative qualification hurdle
}

export interface SurvivalStats {
  qualifiedSignalsCount: number;
  revalidatedSignalsCount: number;
  revalidationSurvivalPercentage: number | null;
  accumulatedConservativeNetUSDC: number;
  disappearanceReasons: Record<string, number>;
}

export interface LatencyReport {
  decodeLatencyUs: PercentileStats;
  quoteLatencyUs: PercentileStats;
  validationLatencyUs: PercentileStats;
  detectionToDecisionUs: PercentileStats;
  rejectedDecisionUs: PercentileStats;
  queueWaitUs: PercentileStats;
  routeLookupUs: PercentileStats;
  rpcLatencyMs: PercentileStats;
  lastSlotLag: number;
  lastReconnectDurationMs: number;
  eventLoopDelayMs: number;
  totalDecisionsMeasured: number;

  // Hyperspeed Multi-Stage Telemetry (T0..T7)
  t0ToT6TotalUs: PercentileStats;          // T0 -> T6: Total detection latency from WS packet to QUALIFIED signal (count = qualified signals)
  t0ToT1DecodeUs: PercentileStats;         // T0 -> T1: Account decode & format validation
  t1ToT2CacheUs: PercentileStats;          // T1 -> T2: Shared state cache update
  t2ToT3RoutesUs: PercentileStats;         // T2 -> T3: Affected routes identification (captured AFTER lookup)
  t3ToT4QuotingUs: PercentileStats;        // T3 -> T4: Multi-leg optimal sizing & quote calculation
  t4ToT5CalcUs: PercentileStats;           // T4 -> T5: Conservative net profit calculation
  t5ToT6SignalUs: PercentileStats;         // T5 -> T6: Scoring & actual qualified signal emission (count = qualified signals)
  revalidationDurationUs: PercentileStats; // T6 -> T7: Immediate revalidation duration (count = revalidated signals)

  // Survival intelligence
  survivalStats: SurvivalStats;
}

export class LatencyTracker {
  private static readonly MAX_SAMPLES = 5000;

  private decodeSamplesUs: number[] = [];
  private quoteSamplesUs: number[] = [];
  private validationSamplesUs: number[] = [];
  private decisionSamplesUs: number[] = [];
  private rejectedDecisionSamplesUs: number[] = [];
  private queueWaitSamplesUs: number[] = [];
  private routeLookupSamplesUs: number[] = [];
  private rpcSamplesMs: number[] = [];

  // Multi-Stage Pipeline Samples (T0..T7)
  private t0ToT6SamplesUs: number[] = [];
  private t0ToT1SamplesUs: number[] = [];
  private t1ToT2SamplesUs: number[] = [];
  private t2ToT3SamplesUs: number[] = [];
  private t3ToT4SamplesUs: number[] = [];
  private t4ToT5SamplesUs: number[] = [];
  private t5ToT6SamplesUs: number[] = [];
  private revalidationSamplesUs: number[] = [];

  // Survival tracking
  private qualifiedSignalsCount = 0;
  private revalidatedSignalsCount = 0;
  private accumulatedConservativeNetUSDC = 0;
  private disappearanceReasons: Record<string, number> = {};

  private lastSlotLag = 0;
  private lastReconnectDurationMs = 0;
  private currentEventLoopDelayMs = 0;
  private lastLoopCheckTime = performance.now();

  constructor() {
    this.startEventLoopMonitor();
  }

  private startEventLoopMonitor(): void {
    const checkDelay = () => {
      const now = performance.now();
      const delta = now - this.lastLoopCheckTime;
      // Expected delay ~50ms; excess is event-loop delay
      this.currentEventLoopDelayMs = Math.max(0, delta - 50);
      this.lastLoopCheckTime = performance.now();
      setTimeout(checkDelay, 50).unref();
    };
    setTimeout(checkDelay, 50).unref();
  }

  public measureEventLoopDelay(): number {
    return this.currentEventLoopDelayMs;
  }

  public recordQueueWait(durationUs: number): void {
    this.addSample(this.queueWaitSamplesUs, durationUs);
  }

  public recordRouteLookupDuration(durationUs: number): void {
    this.addSample(this.routeLookupSamplesUs, durationUs);
  }

  public recordDecodeDuration(durationUs: number): void {
    this.addSample(this.decodeSamplesUs, durationUs);
  }

  public recordQuoteDuration(durationUs: number): void {
    this.addSample(this.quoteSamplesUs, durationUs);
  }

  public recordValidationDuration(durationUs: number): void {
    this.addSample(this.validationSamplesUs, durationUs);
  }

  public recordDecisionDuration(durationUs: number): void {
    this.addSample(this.decisionSamplesUs, durationUs);
  }

  public recordRejectedDecision(durationUs: number): void {
    this.addSample(this.rejectedDecisionSamplesUs, durationUs);
    this.addSample(this.decisionSamplesUs, durationUs);
  }

  public recordRpcLatency(durationMs: number): void {
    this.addSample(this.rpcSamplesMs, durationMs);
  }

  public recordSlotLag(slotLag: number): void {
    this.lastSlotLag = slotLag;
  }

  public recordReconnectDuration(durationMs: number): void {
    this.lastReconnectDurationMs = durationMs;
  }

  /**
   * Records high-precision monotonic pipeline stages (T0 -> T6 -> T7)
   */
  public recordPipelineStages(stages: PipelineStages): void {
    const { t0, tDequeue, t1, t2, tLookupStart, t3, tEvalStart, t4, t5, t6, t7, isQualified } = stages;

    // Queue wait latency (T0 -> tDequeue)
    if (t0 > 0 && tDequeue !== undefined && tDequeue >= t0) {
      this.addSample(this.queueWaitSamplesUs, (tDequeue - t0) * 1000);
    }

    // Account decode & format validation (T0 -> T1)
    if (t0 > 0 && t1 >= t0) {
      this.addSample(this.t0ToT1SamplesUs, (t1 - t0) * 1000);
      this.addSample(this.decodeSamplesUs, (t1 - t0) * 1000);
    }

    // Shared state cache update (T1 -> T2)
    if (t1 > 0 && t2 >= t1) {
      this.addSample(this.t1ToT2SamplesUs, (t2 - t1) * 1000);
    }

    // Route identification duration (tLookupStart -> T3 or T2 -> T3)
    if (tLookupStart !== undefined && t3 >= tLookupStart) {
      this.addSample(this.routeLookupSamplesUs, (t3 - tLookupStart) * 1000);
    }
    if (t2 > 0 && t3 >= t2) {
      this.addSample(this.t2ToT3SamplesUs, (t3 - t2) * 1000);
    }

    // Multi-leg quoting duration (tEvalStart -> T4 or T3 -> T4)
    const quoteBase = tEvalStart !== undefined && tEvalStart > 0 ? tEvalStart : t3;
    if (quoteBase > 0 && t4 >= quoteBase) {
      this.addSample(this.t3ToT4SamplesUs, (t4 - quoteBase) * 1000);
      this.addSample(this.quoteSamplesUs, (t4 - quoteBase) * 1000);
    }

    // Net profit calculation (T4 -> T5)
    if (t4 > 0 && t5 >= t4) {
      this.addSample(this.t4ToT5SamplesUs, (t5 - t4) * 1000);
    }

    // ACTUAL QUALIFIED SIGNAL EMISSION (T5 -> T6 & T0 -> T6)
    // Recorded ONLY when opportunity meets conservative qualification hurdle
    const isQual = isQualified ?? (t6 !== undefined);
    if (isQual && t6 !== undefined && t6 >= t5) {
      this.addSample(this.t5ToT6SamplesUs, (t6 - t5) * 1000);
      this.addSample(this.validationSamplesUs, (t6 - t5) * 1000);

      if (t0 > 0 && t6 >= t0) {
        const totalDetectionUs = (t6 - t0) * 1000;
        this.addSample(this.t0ToT6SamplesUs, totalDetectionUs);
        this.addSample(this.decisionSamplesUs, totalDetectionUs);
      }
    }

    // Immediate revalidation duration (T6 -> T7)
    if (isQual && t6 !== undefined && t7 !== undefined && t7 >= t6) {
      this.addSample(this.revalidationSamplesUs, (t7 - t6) * 1000);
    }
  }

  /**
   * Tracks qualified signals and immediate revalidation outcome (T7)
   */
  public recordSignalQualification(
    isQualified: boolean,
    isRevalidated: boolean,
    conservativeNetUSDC: number = 0,
    disappearanceReason?: string
  ): void {
    if (!isQualified) return;

    this.qualifiedSignalsCount++;

    if (isRevalidated) {
      this.revalidatedSignalsCount++;
      this.accumulatedConservativeNetUSDC += Math.max(0, conservativeNetUSDC);
    } else if (disappearanceReason) {
      this.disappearanceReasons[disappearanceReason] = (this.disappearanceReasons[disappearanceReason] || 0) + 1;
    }
  }

  public recordOpportunityDisappearance(reason: string): void {
    this.disappearanceReasons[reason] = (this.disappearanceReasons[reason] || 0) + 1;
  }

  public getSurvivalStats(): SurvivalStats {
    const survivalPct = this.qualifiedSignalsCount > 0
      ? Number(((this.revalidatedSignalsCount / this.qualifiedSignalsCount) * 100).toFixed(2))
      : null;

    return {
      qualifiedSignalsCount: this.qualifiedSignalsCount,
      revalidatedSignalsCount: this.revalidatedSignalsCount,
      revalidationSurvivalPercentage: survivalPct,
      accumulatedConservativeNetUSDC: Number(this.accumulatedConservativeNetUSDC.toFixed(4)),
      disappearanceReasons: { ...this.disappearanceReasons }
    };
  }

  private addSample(array: number[], val: number): void {
    if (val < 0 || isNaN(val)) return;
    if (array.length >= LatencyTracker.MAX_SAMPLES) {
      array.shift();
    }
    array.push(val);
  }

  private calculatePercentiles(samples: number[]): PercentileStats {
    if (samples.length === 0) {
      return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const count = sorted.length;
    const min = sorted[0];
    const max = sorted[count - 1];
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = sum / count;

    const p50 = sorted[Math.floor(count * 0.50)];
    const p95 = sorted[Math.floor(count * 0.95)] || max;
    const p99 = sorted[Math.floor(count * 0.99)] || max;

    return {
      count,
      min: Number(min.toFixed(2)),
      p50: Number(p50.toFixed(2)),
      p95: Number(p95.toFixed(2)),
      p99: Number(p99.toFixed(2)),
      max: Number(max.toFixed(2)),
      mean: Number(mean.toFixed(2))
    };
  }

  public getReport(): LatencyReport {
    return {
      decodeLatencyUs: this.calculatePercentiles(this.decodeSamplesUs),
      quoteLatencyUs: this.calculatePercentiles(this.quoteSamplesUs),
      validationLatencyUs: this.calculatePercentiles(this.validationSamplesUs),
      detectionToDecisionUs: this.calculatePercentiles(this.decisionSamplesUs),
      rejectedDecisionUs: this.calculatePercentiles(this.rejectedDecisionSamplesUs),
      queueWaitUs: this.calculatePercentiles(this.queueWaitSamplesUs),
      routeLookupUs: this.calculatePercentiles(this.routeLookupSamplesUs),
      rpcLatencyMs: this.calculatePercentiles(this.rpcSamplesMs),
      lastSlotLag: this.lastSlotLag,
      lastReconnectDurationMs: Number(this.lastReconnectDurationMs.toFixed(2)),
      eventLoopDelayMs: Number(this.currentEventLoopDelayMs.toFixed(2)),
      totalDecisionsMeasured: this.decisionSamplesUs.length,

      // Hyperspeed Multi-Stage Telemetry (T0..T7)
      t0ToT6TotalUs: this.calculatePercentiles(this.t0ToT6SamplesUs),
      t0ToT1DecodeUs: this.calculatePercentiles(this.t0ToT1SamplesUs),
      t1ToT2CacheUs: this.calculatePercentiles(this.t1ToT2SamplesUs),
      t2ToT3RoutesUs: this.calculatePercentiles(this.t2ToT3SamplesUs),
      t3ToT4QuotingUs: this.calculatePercentiles(this.t3ToT4SamplesUs),
      t4ToT5CalcUs: this.calculatePercentiles(this.t4ToT5SamplesUs),
      t5ToT6SignalUs: this.calculatePercentiles(this.t5ToT6SamplesUs),
      revalidationDurationUs: this.calculatePercentiles(this.revalidationSamplesUs),

      survivalStats: this.getSurvivalStats()
    };
  }
}
