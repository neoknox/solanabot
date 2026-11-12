export interface PercentileStats {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface LatencyReport {
  decodeLatencyUs: PercentileStats;
  quoteLatencyUs: PercentileStats;
  validationLatencyUs: PercentileStats;
  detectionToDecisionUs: PercentileStats;
  rpcLatencyMs: PercentileStats;
  lastSlotLag: number;
  lastReconnectDurationMs: number;
  eventLoopDelayMs: number;
  totalDecisionsMeasured: number;
}

export class LatencyTracker {
  private static readonly MAX_SAMPLES = 5000;

  private decodeSamplesUs: number[] = [];
  private quoteSamplesUs: number[] = [];
  private validationSamplesUs: number[] = [];
  private decisionSamplesUs: number[] = [];
  private rpcSamplesMs: number[] = [];

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

  public recordRpcLatency(durationMs: number): void {
    this.addSample(this.rpcSamplesMs, durationMs);
  }

  public recordSlotLag(lag: number): void {
    this.lastSlotLag = Math.max(0, lag);
  }

  public recordReconnectDuration(durationMs: number): void {
    this.lastReconnectDurationMs = durationMs;
  }

  private addSample(array: number[], value: number): void {
    if (array.length >= LatencyTracker.MAX_SAMPLES) {
      array.shift();
    }
    array.push(value);
  }

  private calculatePercentiles(samples: number[]): PercentileStats {
    if (samples.length === 0) {
      return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    const getP = (p: number) => {
      const idx = Math.min(count - 1, Math.floor((p / 100) * count));
      return sorted[idx];
    };

    return {
      count,
      min: sorted[0],
      p50: getP(50),
      p95: getP(95),
      p99: getP(99),
      max: sorted[count - 1],
      mean: Math.round((sum / count) * 100) / 100
    };
  }

  public getReport(): LatencyReport {
    return {
      decodeLatencyUs: this.calculatePercentiles(this.decodeSamplesUs),
      quoteLatencyUs: this.calculatePercentiles(this.quoteSamplesUs),
      validationLatencyUs: this.calculatePercentiles(this.validationSamplesUs),
      detectionToDecisionUs: this.calculatePercentiles(this.decisionSamplesUs),
      rpcLatencyMs: this.calculatePercentiles(this.rpcSamplesMs),
      lastSlotLag: this.lastSlotLag,
      lastReconnectDurationMs: this.lastReconnectDurationMs,
      eventLoopDelayMs: Math.round(this.currentEventLoopDelayMs * 100) / 100,
      totalDecisionsMeasured: this.decisionSamplesUs.length
    };
  }

  public reset(): void {
    this.decodeSamplesUs = [];
    this.quoteSamplesUs = [];
    this.validationSamplesUs = [];
    this.decisionSamplesUs = [];
    this.rpcSamplesMs = [];
  }
}
