import { AppConfig } from '../config/index.js';
import { CreditAlertLevel, CreditMeterSource, HeliusCreditMeterData } from '../types/index.js';

export interface HeliusCreditTrackerOptions {
  config?: AppConfig;
  rpcHttpUrl?: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number; // Default: 5 minutes (300,000 ms)
  projectId?: string;
  adminKey?: string;
  creditLimit?: number; // Default: 1,000,000
}

interface UsageRateSample {
  timestamp: number;
  creditsUsed: number;
}

export class HeliusCreditTracker {
  private rpcHttpUrl: string;
  private isHeliusActive: boolean;
  private apiKey: string | null = null;
  private projectId: string | null = null;
  private adminKey: string | null = null;
  private creditLimit: number;
  private pollIntervalMs: number;
  private fetchFn: typeof fetch;

  private pollTimer: NodeJS.Timeout | null = null;
  private adminApiAvailable: boolean = true;

  // Local telemetry
  private rpcRequestsTotal: number = 0;
  private wsBytesTotal: number = 0;

  // Rate tracking samples (sliding window)
  private rateSamples: UsageRateSample[] = [];

  // Preserved snapshot
  private snapshot: {
    creditsUsed: number;
    creditsRemaining: number;
    creditsLimit: number;
    source: CreditMeterSource;
    sourceLabel: string;
    billingCycleResetDate: string | null;
    timestamp: number;
  };

  constructor(options?: HeliusCreditTrackerOptions) {
    this.rpcHttpUrl = options?.rpcHttpUrl ?? options?.config?.SOLANA_RPC_HTTP ?? process.env.SOLANA_RPC_HTTP ?? '';
    this.isHeliusActive = this.detectIsHelius(this.rpcHttpUrl);
    this.apiKey = this.extractApiKey(this.rpcHttpUrl);
    this.projectId = options?.projectId ?? process.env.HELIUS_PROJECT_ID ?? null;
    this.adminKey = options?.adminKey ?? process.env.HELIUS_ADMIN_KEY ?? this.apiKey;
    this.creditLimit = options?.creditLimit ?? 1_000_000;
    this.pollIntervalMs = options?.pollIntervalMs ?? 300_000; // 5 minutes
    this.fetchFn = options?.fetchFn ?? fetch;

    const now = Date.now();
    this.snapshot = {
      creditsUsed: 0,
      creditsRemaining: this.creditLimit,
      creditsLimit: this.creditLimit,
      source: 'ESTIMATED_LOCAL',
      sourceLabel: 'ESTIMATED LOCAL USAGE',
      billingCycleResetDate: null,
      timestamp: now
    };

    this.rateSamples.push({ timestamp: now, creditsUsed: 0 });
  }

  private detectIsHelius(url: string): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('helius-rpc.com') || parsed.hostname.includes('helius.xyz');
    } catch {
      return url.includes('helius-rpc.com') || url.includes('helius.xyz');
    }
  }

  private extractApiKey(url: string): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('api-key');
    } catch {
      const match = url.match(/[?&]api-key=([^&]+)/);
      return match ? match[1] : null;
    }
  }

  public setRpcEndpoint(url: string): void {
    const wasHelius = this.isHeliusActive;
    this.rpcHttpUrl = url;
    this.isHeliusActive = this.detectIsHelius(url);
    this.apiKey = this.extractApiKey(url);

    if (this.isHeliusActive && !wasHelius) {
      // Re-activated Helius: trigger poll if admin API configured
      this.pollProjectUsage().catch(() => {});
    }
  }

  public setLocalTelemetry(rpcRequests: number, wsBytes: number): void {
    this.rpcRequestsTotal = Math.max(this.rpcRequestsTotal, rpcRequests);
    this.wsBytesTotal = Math.max(this.wsBytesTotal, wsBytes);

    if (this.snapshot.source === 'ESTIMATED_LOCAL') {
      const estimatedCredits = this.calculateLocalEstimate();
      this.updateSnapshot(estimatedCredits, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE', this.snapshot.billingCycleResetDate);
    }
  }

  public recordRpcRequest(count: number = 1): void {
    this.rpcRequestsTotal += count;
    if (this.snapshot.source === 'ESTIMATED_LOCAL') {
      const estimatedCredits = this.calculateLocalEstimate();
      this.updateSnapshot(estimatedCredits, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE', this.snapshot.billingCycleResetDate);
    }
  }

  public recordWsTraffic(bytes: number): void {
    this.wsBytesTotal += bytes;
    if (this.snapshot.source === 'ESTIMATED_LOCAL') {
      const estimatedCredits = this.calculateLocalEstimate();
      this.updateSnapshot(estimatedCredits, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE', this.snapshot.billingCycleResetDate);
    }
  }

  private calculateLocalEstimate(): number {
    // Official Helius Free Pricing:
    // 1 credit per HTTP RPC request
    // 2 credits per 0.1 MB (20 credits per 1 MB) of WebSocket data transfer
    const wsCredits = this.wsBytesTotal > 0 ? Math.ceil((this.wsBytesTotal / (100 * 1024)) * 2) : 0;
    return Math.min(this.creditLimit, this.rpcRequestsTotal + wsCredits);
  }

  public async pollProjectUsage(): Promise<boolean> {
    // Do not poll Helius unnecessarily when public RPC is active
    if (!this.isHeliusActive) {
      return false;
    }

    // Admin API requires both a project ID and an admin key
    if (!this.projectId || !this.adminKey || !this.adminApiAvailable) {
      return false;
    }

    try {
      const url = `https://admin-api.helius.xyz/v0/admin/projects/${encodeURIComponent(this.projectId)}/usage`;
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          'X-Api-Key': this.adminKey
        }
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          // Free project lacks Admin API token or endpoint unavailable
          this.adminApiAvailable = false;
        }
        return false;
      }

      const data = await res.json() as any;
      const creditsUsed = typeof data.creditsUsed === 'number' ? data.creditsUsed :
        (typeof data.requests?.rpc === 'number' ? data.requests.rpc : this.calculateLocalEstimate());
      
      const creditsLimit = typeof data.subscriptionDetails?.creditsLimit === 'number'
        ? data.subscriptionDetails.creditsLimit
        : this.creditLimit;

      const resetDate = data.creditCycle?.end ?? data.subscriptionDetails?.billingCycle?.end ?? null;

      // Project-level billing usage must not be mislabeled as SOLANABOT-only consumption
      this.updateSnapshot(creditsUsed, 'REAL_BILLING_API', 'HELIUS PROJECT BILLING', resetDate, creditsLimit);
      return true;
    } catch {
      return false;
    }
  }

  public startPolling(): void {
    if (this.pollTimer) return;
    // Initial poll
    this.pollProjectUsage().catch(() => {});
    this.pollTimer = setInterval(() => {
      this.pollProjectUsage().catch(() => {});
    }, this.pollIntervalMs);
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public updateSnapshot(
    creditsUsed: number,
    source: CreditMeterSource,
    sourceLabel: string,
    billingCycleResetDate: string | null = null,
    creditsLimit: number = this.creditLimit
  ): void {
    const now = Date.now();
    const used = Math.max(0, creditsUsed);
    const remaining = Math.max(0, creditsLimit - used);

    this.snapshot = {
      creditsUsed: used,
      creditsRemaining: remaining,
      creditsLimit,
      source,
      sourceLabel,
      billingCycleResetDate,
      timestamp: now
    };

    this.recordRateSample(now, used);
  }

  private recordRateSample(now: number, creditsUsed: number): void {
    this.rateSamples.push({ timestamp: now, creditsUsed });
    // Keep last 30 minutes of samples
    const cutoff = now - 1800_000;
    this.rateSamples = this.rateSamples.filter(s => s.timestamp >= cutoff);
  }

  public calculateUsageRateCreditsPerHour(): number {
    if (this.rateSamples.length < 2) return 0;
    const oldest = this.rateSamples[0];
    const newest = this.rateSamples[this.rateSamples.length - 1];
    const durationHours = (newest.timestamp - oldest.timestamp) / 3600_000;
    if (durationHours <= 0.0001) return 0;

    const deltaCredits = Math.max(0, newest.creditsUsed - oldest.creditsUsed);
    return Math.round((deltaCredits / durationHours) * 10) / 10;
  }

  public getCreditMeterData(): HeliusCreditMeterData {
    const { creditsUsed, creditsRemaining, creditsLimit, source, sourceLabel, billingCycleResetDate, timestamp } = this.snapshot;
    const percentageUsed = Math.min(100, Math.round((creditsUsed / creditsLimit) * 1000) / 10);
    const usageRateCreditsPerHour = this.calculateUsageRateCreditsPerHour();

    let estimatedDaysRemaining: number | null = null;
    if (usageRateCreditsPerHour > 0 && creditsRemaining > 0) {
      const days = creditsRemaining / (usageRateCreditsPerHour * 24);
      estimatedDaysRemaining = Math.round(days * 10) / 10;
    }

    // Alert thresholds
    let alertLevel: CreditAlertLevel = 'NORMAL';
    let alertColor: 'green' | 'yellow' | 'orange' | 'red' = 'green';
    let alertMessage: string | undefined;
    let recommendation: string | undefined;

    if (percentageUsed >= 100) {
      alertLevel = 'LIMIT_REACHED';
      alertColor = 'red';
      alertMessage = 'LIMIT REACHED: 1,000,000 Free credits consumed.';
      recommendation = 'Switch to public RPC immediately (SOLANA_RPC_HTTP=https://api.mainnet-beta.solana.com).';
    } else if (percentageUsed >= 90) {
      alertLevel = 'WARNING_90';
      alertColor = 'red';
      alertMessage = 'CRITICAL WARNING: 90%+ Helius free credits used. Provider exhaustion imminent.';
      recommendation = 'Recommend switching to public RPC to avoid scanner downtime.';
    } else if (percentageUsed >= 80) {
      alertLevel = 'WARNING_80';
      alertColor = 'orange';
      alertMessage = '80%+ Helius free credits consumed.';
      recommendation = 'Recommend switching to public RPC (SOLANA_RPC_HTTP=https://api.mainnet-beta.solana.com).';
    } else if (percentageUsed >= 50) {
      alertLevel = 'WARNING_50';
      alertColor = 'yellow';
      alertMessage = '50%+ Helius free credits used.';
    }

    const elapsedMs = Math.max(0, Date.now() - timestamp);
    const lastUpdatedFormatted = this.formatRelativeTime(elapsedMs);

    const burnRateCreditsPerHour = usageRateCreditsPerHour;
    let projectedExhaustionHours: number | null = null;
    let projectedExhaustionDate: string | null = null;

    if (burnRateCreditsPerHour > 0 && creditsRemaining > 0) {
      projectedExhaustionHours = Math.round((creditsRemaining / burnRateCreditsPerHour) * 10) / 10;
      projectedExhaustionDate = new Date(Date.now() + projectedExhaustionHours * 3600_000).toISOString();
    }

    // 24/7 scanning sustainable limit on Free (1,000,000 credits / 732 hours in 30.5-day month = 1,366.1 credits/hr)
    const MAX_FREE_24X7_HOURLY_RATE = 1366.1;
    const is24x7SustainableOnFree = burnRateCreditsPerHour <= MAX_FREE_24X7_HOURLY_RATE;
    const requiredMonthlyCreditsFor24x7 = Math.round(burnRateCreditsPerHour * 732);

    return {
      enabled: true,
      isHeliusActive: this.isHeliusActive,
      providerDisplay: this.isHeliusActive ? 'HELIUS' : 'PUBLIC SOLANA',
      statusDisplay: this.isHeliusActive ? 'ACTIVE' : 'HELIUS INACTIVE',
      source,
      sourceLabel,
      creditsUsed,
      creditsRemaining,
      creditsLimit,
      percentageUsed,
      usageRateCreditsPerHour,
      estimatedDaysRemaining,
      billingCycleResetDate,
      lastUpdatedTimestamp: timestamp,
      lastUpdatedFormatted,
      alertLevel,
      alertColor,
      alertMessage,
      recommendation,
      dashboardUrl: 'https://dashboard.helius.dev/',
      burnRateCreditsPerHour,
      projectedExhaustionDate,
      projectedExhaustionHours,
      is24x7SustainableOnFree,
      requiredMonthlyCreditsFor24x7
    };
  }

  private formatRelativeTime(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 5) return 'Just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    return `${hours}h ago`;
  }
}
