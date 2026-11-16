import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusCreditTracker } from '../src/hud/heliusCreditTracker.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import http from 'http';

describe('SOLANABOT — HUD V2 Helius Credit Meter & Tracking Suite', () => {
  const MOCK_API_KEY = 'secret-helius-key-12345';
  const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${MOCK_API_KEY}`;
  const PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Real Usage API Supported
  it('1. retrieves real billing usage from official Admin API when supported and authorized', async () => {
    const mockApiResponse = {
      creditsRemaining: 486100,
      creditsUsed: 513900,
      creditCycle: {
        start: '2026-11-01',
        end: '2026-12-01'
      },
      subscriptionDetails: {
        billingCycle: {
          start: '2026-11-01',
          end: '2026-12-01'
        },
        creditsLimit: 1000000,
        plan: 'free'
      }
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockApiResponse
    });

    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL,
      projectId: 'proj-uuid-999',
      adminKey: MOCK_API_KEY,
      fetchFn: mockFetch as any
    });

    const pollResult = await tracker.pollProjectUsage();
    expect(pollResult).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const data = tracker.getCreditMeterData();
    expect(data.enabled).toBe(true);
    expect(data.isHeliusActive).toBe(true);
    expect(data.providerDisplay).toBe('HELIUS');
    expect(data.statusDisplay).toBe('ACTIVE');
    expect(data.source).toBe('REAL_BILLING_API');
    expect(data.sourceLabel).toBe('HELIUS PROJECT BILLING');
    expect(data.creditsUsed).toBe(513900);
    expect(data.creditsRemaining).toBe(486100);
    expect(data.creditsLimit).toBe(1000000);
    expect(data.percentageUsed).toBe(51.4);
    expect(data.billingCycleResetDate).toBe('2026-12-01');
    expect(data.dashboardUrl).toBe('https://dashboard.helius.dev/');
  });

  // 2. Usage API Unavailable (Fallback to Local Telemetry)
  it('2. falls back cleanly to ESTIMATED LOCAL USAGE when official API is unavailable', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    });

    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL,
      projectId: 'proj-uuid-999',
      adminKey: MOCK_API_KEY,
      fetchFn: mockFetch as any
    });

    const pollResult = await tracker.pollProjectUsage();
    expect(pollResult).toBe(false);

    // Record local RPC and WebSocket telemetry
    tracker.setLocalTelemetry(120, 204800); // 120 RPC reqs + 200 KB WS (~200 credits) => 320 credits

    const data = tracker.getCreditMeterData();
    expect(data.source).toBe('ESTIMATED_LOCAL');
    expect(data.sourceLabel).toBe('ESTIMATED LOCAL USAGE');
    expect(data.creditsUsed).toBe(320);
    expect(data.creditsRemaining).toBe(1000000 - 320);
    expect(data.dashboardUrl).toBe('https://dashboard.helius.dev/');
  });

  // 3. Public RPC Active (HELIUS INACTIVE & Snapshot Preservation)
  it('3. displays HELIUS INACTIVE when Public RPC is active and preserves last snapshot without zeroing', async () => {
    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL
    });

    tracker.updateSnapshot(250000, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE', null, 1000000);
    const beforeData = tracker.getCreditMeterData();
    expect(beforeData.creditsUsed).toBe(250000);
    expect(beforeData.statusDisplay).toBe('ACTIVE');

    // Switch to Public RPC
    tracker.setRpcEndpoint(PUBLIC_RPC_URL);

    const afterData = tracker.getCreditMeterData();
    expect(afterData.isHeliusActive).toBe(false);
    expect(afterData.providerDisplay).toBe('PUBLIC SOLANA');
    expect(afterData.statusDisplay).toBe('HELIUS INACTIVE');
    // Does NOT zero out credits used merely because Helius is inactive
    expect(afterData.creditsUsed).toBe(250000);
    expect(afterData.creditsRemaining).toBe(750000);
    expect(afterData.lastUpdatedTimestamp).toBe(beforeData.lastUpdatedTimestamp);

    // Verifies it does not poll Helius when public RPC is active
    const mockFetch = vi.fn();
    (tracker as any).fetchFn = mockFetch;
    const pollRes = await tracker.pollProjectUsage();
    expect(pollRes).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 4. Helius Active Status
  it('4. displays ACTIVE status and tracks live usage when Helius endpoint is active', () => {
    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL
    });

    expect(tracker.getCreditMeterData().isHeliusActive).toBe(true);
    expect(tracker.getCreditMeterData().providerDisplay).toBe('HELIUS');
    expect(tracker.getCreditMeterData().statusDisplay).toBe('ACTIVE');

    tracker.recordRpcRequest(10);
    tracker.recordWsTraffic(10240); // 10 credits
    const data = tracker.getCreditMeterData();
    expect(data.creditsUsed).toBe(20);
  });

  // 5. Stale Billing Data & Relative Timestamp Formatting
  it('5. preserves last snapshot timestamp and accurately formats relative time', () => {
    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL
    });

    const now = Date.now();
    tracker.updateSnapshot(100, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE', null, 1000000);

    const data = tracker.getCreditMeterData();
    expect(data.lastUpdatedFormatted).toBe('Just now');
    expect(data.lastUpdatedTimestamp).toBeGreaterThan(0);
  });

  // 6. Official Billing Cycle Reset Information
  it('6. handles dynamic official billing cycle reset information without assuming fixed dates', () => {
    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL
    });

    tracker.updateSnapshot(15000, 'REAL_BILLING_API', 'HELIUS PROJECT BILLING', '2026-12-15T00:00:00Z', 1000000);
    const data = tracker.getCreditMeterData();
    expect(data.billingCycleResetDate).toBe('2026-12-15T00:00:00Z');
  });

  // 7. Alert Thresholds & Recommendations
  describe('7. Alert Thresholds (50% Yellow, 80% Orange, 90% Red, 100% Limit Reached)', () => {
    it('Normal level (< 50%): Green status, no alert', () => {
      const tracker = new HeliusCreditTracker({ rpcHttpUrl: HELIUS_RPC_URL });
      tracker.updateSnapshot(450000, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE'); // 45%
      const data = tracker.getCreditMeterData();
      expect(data.alertLevel).toBe('NORMAL');
      expect(data.alertColor).toBe('green');
      expect(data.alertMessage).toBeUndefined();
    });

    it('50% Threshold: Yellow status, warning message', () => {
      const tracker = new HeliusCreditTracker({ rpcHttpUrl: HELIUS_RPC_URL });
      tracker.updateSnapshot(500000, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE'); // 50%
      const data = tracker.getCreditMeterData();
      expect(data.alertLevel).toBe('WARNING_50');
      expect(data.alertColor).toBe('yellow');
      expect(data.alertMessage).toContain('50%+');
    });

    it('80% Threshold: Orange status, recommends switching to Public RPC', () => {
      const tracker = new HeliusCreditTracker({ rpcHttpUrl: HELIUS_RPC_URL });
      tracker.updateSnapshot(800000, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE'); // 80%
      const data = tracker.getCreditMeterData();
      expect(data.alertLevel).toBe('WARNING_80');
      expect(data.alertColor).toBe('orange');
      expect(data.alertMessage).toContain('80%+');
      expect(data.recommendation).toContain('Recommend switching to public RPC');
    });

    it('90% Threshold: Red status, prominent warning message', () => {
      const tracker = new HeliusCreditTracker({ rpcHttpUrl: HELIUS_RPC_URL });
      tracker.updateSnapshot(920000, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE'); // 92%
      const data = tracker.getCreditMeterData();
      expect(data.alertLevel).toBe('WARNING_90');
      expect(data.alertColor).toBe('red');
      expect(data.alertMessage).toContain('CRITICAL WARNING: 90%+');
      expect(data.recommendation).toBeDefined();
    });

    it('100% Threshold: LIMIT REACHED, immediate switch instruction', () => {
      const tracker = new HeliusCreditTracker({ rpcHttpUrl: HELIUS_RPC_URL });
      tracker.updateSnapshot(1000000, 'ESTIMATED_LOCAL', 'ESTIMATED LOCAL USAGE'); // 100%
      const data = tracker.getCreditMeterData();
      expect(data.alertLevel).toBe('LIMIT_REACHED');
      expect(data.alertColor).toBe('red');
      expect(data.alertMessage).toContain('LIMIT REACHED');
      expect(data.recommendation).toContain('Switch to public RPC immediately');
    });
  });

  // 8. Security: Never Expose API Keys
  it('8. strictly prevents any API key or credential leakage in payloads or outputs', () => {
    const tracker = new HeliusCreditTracker({
      rpcHttpUrl: HELIUS_RPC_URL,
      projectId: 'proj-1234',
      adminKey: MOCK_API_KEY
    });

    const data = tracker.getCreditMeterData();
    const jsonStr = JSON.stringify(data);
    expect(jsonStr).not.toContain(MOCK_API_KEY);
    expect(jsonStr).not.toContain('api-key');
    expect(jsonStr).not.toContain('secret-helius-key');
  });

  // 9. ProfitHudServer Integration
  it('9. delivers credit meter in ProfitHudServer /api/status and embeds markup in HTML', async () => {
    const thresholdManager = new ProfitThresholdManager({ initialThresholdUSDC: 0.10 });
    const hud = new ProfitHudServer(thresholdManager, undefined, { port: 3045, silent: true });

    try {
      await hud.start();

      // Test GET /api/status delivers credit meter
      const statusRes = await fetch('http://127.0.0.1:3045/api/status');
      expect(statusRes.ok).toBe(true);
      const json = await statusRes.json() as any;
      expect(json.creditMeter).toBeDefined();
      expect(json.creditMeter.creditsLimit).toBe(1000000);
      expect(json.creditMeter.dashboardUrl).toBe('https://dashboard.helius.dev/');

      // Test GET / HTML includes the credit meter container and elements
      const htmlRes = await fetch('http://127.0.0.1:3045/');
      expect(htmlRes.ok).toBe(true);
      const html = await htmlRes.text();
      expect(html).toContain('id="heliusCreditMeterBox"');
      expect(html).toContain('HELIUS FREE CREDITS');
      expect(html).toContain('id="creditBarFill"');
      expect(html).toContain('id="creditsUsedVal"');
      expect(html).toContain('id="creditsRemVal"');
      expect(html).toContain('https://dashboard.helius.dev/');
      expect(html).not.toContain(MOCK_API_KEY);
    } finally {
      await hud.stop();
    }
  });
});
