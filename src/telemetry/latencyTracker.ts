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

  public measureEventLoopDelay(): number {
    return this.currentEventLoopDelayMs;
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

  public recordSlotLag(slotLag: number): void {
    this.lastSlotLag = slotLag;
  }

  public recordReconnectDuration(durationMs: number): void {
    this.lastReconnectDurationMs = durationMs;
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
      return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
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
      rpcLatencyMs: this.calculatePercentiles(this.rpcSamplesMs),
      lastSlotLag: this.lastSlotLag,
      lastReconnectDurationMs: Number(this.lastReconnectDurationMs.toFixed(2)),
      eventLoopDelayMs: Number(this.currentEventLoopDelayMs.toFixed(2)),
      totalDecisionsMeasured: this.decisionSamplesUs.length
    };
  }
}
