import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { loadConfig } from '../src/config/index.js';

describe('SOLANABOT — HUD V2 Professional Trading Terminal Suite', () => {
  const testDir = path.join(process.cwd(), 'data', 'test_hud_v2');

  const safeCleanup = () => {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  };

  beforeEach(() => {
    safeCleanup();
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    safeCleanup();
  });

  function getUniqueTestFiles() {
    const id = Math.random().toString(36).substring(2, 8);
    return {
      thresholdFile: path.join(testDir, `profit_threshold_${id}.json`),
      dbFile: path.join(testDir, `test_scanner_${id}.db`)
    };
  }

  function makeHttpRequest(
    urlStr: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {}
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method,
          headers: {
            'Host': parsed.host,
            ...headers
          }
        },
        (res) => {
          let resBody = '';
          res.on('data', chunk => { resBody += chunk; });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: resBody
            });
          });
        }
      );

      req.on('error', reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  // 1. Terminal UI Structure: All 10 Visual & Interactive Sections Present
  it('Terminal UI: Renders all 10 specified trading terminal sections with dark styling and zero external CDN deps', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(`http://127.0.0.1:${info.port}/`, 'GET');
      expect(res.statusCode).toBe(200);
      const html = res.body;

      // Section 1: Top Status Bar
      expect(html).toContain('SOLANABOT');
      expect(html).toContain('HUD V2');
      expect(html).toContain('READ-ONLY / SHADOW MODE');
      expect(html).toContain('id="telemetryScannerStatus"');
      expect(html).toContain('id="rpcStatusBadge"');
      expect(html).toContain('id="telemetryWsBadge"');
      expect(html).toContain('id="telemetrySlot"');
      expect(html).toContain('id="telemetryUptime"');
      expect(html).toContain('id="telemetryLastUpdated"');
      expect(html).toContain('id="btnReconnectWs"');

      // Offline Alert Banner
      expect(html).toContain('id="offlineBanner"');
      expect(html).toContain('BACKEND OFFLINE');

      // Section 2: Live Profit Monitor (Hero Section)
      expect(html).toContain('LIVE PROFIT MONITOR');
      expect(html).toContain('id="statGrossPositive"');
      expect(html).toContain('id="statNetPositive"');
      expect(html).toContain('id="statQualifiedShadow"');
      expect(html).toContain('id="statRevalidatedSurviving"');
      expect(html).toContain('id="statBestConservativeNet"');
      expect(html).toContain('id="statShadowNetRate"');
      expect(html).toContain('$0.00 USDC'); // Realized profit strictly $0.00 in shadow mode
      expect(html).toContain('id="statActiveHurdle"');
      expect(html).toContain('id="statVirtualCapital"');

      // Section 3: Top 10 Profit Watch Table
      expect(html).toContain('TOP 10 PROFIT WATCH');
      expect(html).toContain('id="profitWatchTable"');
      expect(html).toContain('id="profitWatchTbody"');
      expect(html).toContain('Pool 1 Address');
      expect(html).toContain('Pool 2 Address');
      expect(html).toContain('Exact Swap Directions');
      expect(html).toContain('DEX Fees');
      expect(html).toContain('Price Impact');
      expect(html).toContain('Slippage Allowance');
      expect(html).toContain('Safety Buffer Applied');
      expect(html).toContain('Conservative Net Formula');
      expect(html).toContain('Slot Gap');
      expect(html).toContain('Revalidation Result');

      // Section 4: Scanner Performance
      expect(html).toContain('SCANNER PERFORMANCE');
      expect(html).toContain('id="perfRouteEvalsSec"');
      expect(html).toContain('id="perfQuoteCalcsSec"');
      expect(html).toContain('id="perfTotalEvals"');
      expect(html).toContain('id="perfQuoteValid"');
      expect(html).toContain('id="perfAccountUpdatesSec"');
      expect(html).toContain('id="perfQueueDepthDrops"');
      expect(html).toContain('id="perfQueueWaitP95"');
      expect(html).toContain('id="perfQuoteCalcP95"');
      expect(html).toContain('id="perfRpcLatencyP95"');

      // Section 5: Route & Pool Health
      expect(html).toContain('ROUTE & POOL HEALTH');
      expect(html).toContain('id="healthStoredPools"');
      expect(html).toContain('id="healthVerifiedPools"');
      expect(html).toContain('id="healthUniqueRoutes"');
      expect(html).toContain('id="healthReadyUptime"');
      expect(html).toContain('id="stateVerified"');
      expect(html).toContain('id="stateReady"');
      expect(html).toContain('id="stateStale"');
      expect(html).toContain('id="stateBlocked"');
      expect(html).toContain('id="stateUnvalidated"');

      // Section 6: Historical Database vs Current Session
      expect(html).toContain('HISTORICAL PERSISTENCE VS CURRENT SESSION');
      expect(html).toContain('id="histTotalPools"');
      expect(html).toContain('id="histVerifiedPools"');
      expect(html).toContain('id="histUnverifiedPools"');
      expect(html).toContain('id="histTotalRoutes"');
      expect(html).toContain('id="histLastScout"');
      expect(html).toContain('id="sessNewPools"');
      expect(html).toContain('id="sessVerifiedPools"');
      expect(html).toContain('id="sessRejectedCandidates"');
      expect(html).toContain('id="sessNewRoutes"');
      expect(html).toContain('id="sessStartTime"');

      // Section 7: Rejection Analysis
      expect(html).toContain('REJECTION ANALYSIS');
      expect(html).toContain('id="rejectionMostCommon"');
      expect(html).toContain('id="rejectionTable"');
      expect(html).toContain('id="rejectionTbody"');
      expect(html).toContain('EXCESSIVE_PRICE_IMPACT');
      expect(html).toContain('SLOT_MISMATCH');
      expect(html).toContain('STALE_QUOTE');
      expect(html).toContain('WS_DISCONNECTED');
      expect(html).toContain('LOW_CONSERVATIVE_NET');
      expect(html).toContain('INSUFFICIENT_LIQUIDITY');

      // Section 8: Profit Target Control
      expect(html).toContain('PROFIT TARGET CONTROL');
      expect(html).toContain('id="thresholdSlider"');
      expect(html).toContain('id="currentDisplay"');
      expect(html).toContain('id="confirmedBadge"');

      // Section 9: Scout Control
      expect(html).toContain('SCOUT CONTROL');
      expect(html).toContain('id="btnTriggerScout"');
      expect(html).toContain('id="scoutStatusBadge"');
      expect(html).toContain('id="scoutLastRun"');
      expect(html).toContain('id="scoutNextRun"');

      // Section 10: Health & Failure Monitoring
      expect(html).toContain('HEALTH & FAILURE MONITORING');
      expect(html).toContain('id="diagWsReconnects"');
      expect(html).toContain('id="diagWsMessageAge"');
      expect(html).toContain('id="diagWsLastReconnect"');
      expect(html).toContain('id="diagRpcFailures"');
      expect(html).toContain('id="diagPersistenceErrors"');
      expect(html).toContain('id="diagEventLoopDelay"');
      expect(html).toContain('id="diagMemory"');
      expect(html).toContain('id="diagProcessUptime"');

      // Zero external framework / CDN dependencies
      expect(html).not.toContain('react');
      expect(html).not.toContain('vue');
      expect(html).not.toContain('cdn.jsdelivr');
      expect(html).not.toContain('unpkg.com');
      expect(html).not.toContain('cdnjs.cloudflare.com');
    } finally {
      await hud.stop();
    }
  });

  // 2. HUD V2 Full Payload Delivery via GET /api/status
  it('GET /api/status: Delivers complete HUD V2 schema with all metrics, diagnostics, tables, and backward compatibility', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    const hud = new ProfitHudServer(manager, scanner, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(`http://127.0.0.1:${info.port}/api/status`, 'GET');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      // Core flags
      expect(data.success).toBe(true);
      expect(data.mode).toBe('READ-ONLY / SHADOW MODE');
      expect(data.scannerStatus).toBe('ONLINE'); // Backward compatibility
      expect(data.scannerState).toBeDefined();
      expect(data.wsConnected).toBeDefined();

      // Section 2: Profit Monitor
      expect(data.profitMonitor).toBeDefined();
      expect(data.profitMonitor.realizedProfitUSDC).toBe(0);
      expect(typeof data.profitMonitor.bestConservativeNetUSDC).toBe('number');
      expect(typeof data.profitMonitor.shadowNetUSDCPerMinute).toBe('number');

      // Section 3: Profit Watch Table
      expect(Array.isArray(data.profitWatchTable)).toBe(true);

      // Section 4: Performance
      expect(data.performance).toBeDefined();
      expect(typeof data.performance.routeEvaluationsPerSec).toBe('number');
      expect(typeof data.performance.quoteCalculationsPerSec).toBe('number');
      expect(typeof data.performance.eventQueueDrops).toBe('number');

      // Section 5: Route Health
      expect(data.routeHealth).toBeDefined();
      expect(typeof data.routeHealth.totalUnique2LegRoutes).toBe('number');
      expect(typeof data.routeHealth.readyRouteUptimePercent).toBe('number');
      // Verify mutual exclusivity total
      const stateSum = data.routeHealth.verifiedRoutes +
        data.routeHealth.readyRoutes +
        data.routeHealth.staleRoutes +
        data.routeHealth.blockedRoutes +
        data.routeHealth.unvalidatedRoutes;
      expect(stateSum).toBe(data.routeHealth.totalUnique2LegRoutes);

      // Section 6: Historical vs Session
      expect(data.historicalVsSession).toBeDefined();
      expect(data.historicalVsSession.historical).toBeDefined();
      expect(data.historicalVsSession.session).toBeDefined();

      // Section 7: Rejection Analysis
      expect(data.rejectionAnalysis).toBeDefined();
      expect(Array.isArray(data.rejectionAnalysis.categories)).toBe(true);
      expect(data.rejectionAnalysis.categories.length).toBe(7);
      expect(data.rejectionAnalysis.mostCommonBlocker).toBeDefined();

      // Section 8: Target Control
      expect(data.thresholdUSDC).toBe(0.10);
      expect(data.safetyBufferUSDC).toBe(0.25);
      expect(data.sharedVirtualCapitalUSDC).toBe(1000);

      // Section 10: Diagnostics
      expect(data.diagnostics).toBeDefined();
      expect(typeof data.diagnostics.wsReconnectAttempts).toBe('number');
      expect(typeof data.diagnostics.rpcFailures).toBe('number');
      expect(typeof data.diagnostics.eventLoopDelayMs).toBe('number');
      expect(data.diagnostics.processMemory).toBeDefined();
    } finally {
      await hud.stop();
      scanner.stop();
    }
  });

  // 3. Reconnection Lifecycle & HUD State Update
  it('POST /api/ws/reconnect: Safely triggers reconnect and updates HUD connection telemetry', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    vi.spyOn(scanner, 'reconnectWebSocket').mockResolvedValue({
      success: true,
      status: 'CONNECTED',
      slot: 320145210,
      durationMs: 42
    });

    const hud = new ProfitHudServer(manager, scanner, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Origin': `http://127.0.0.1:${info.port}` }
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.wsStatus).toBe('CONNECTED');
      expect(data.slot).toBe(320145210);
      expect(data.durationMs).toBe(42);
    } finally {
      await hud.stop();
      scanner.stop();
    }
  });

  // 4. Browser Tab Favicon: Serves custom Solana icon and embeds in HTML head
  it('Favicon: Serves custom Solana tab icon on /favicon.ico and /favicon.png and renders in HTML head', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const info = await hud.start();

    try {
      // 1. Check HTML head contains favicon links
      const htmlRes = await makeHttpRequest(`http://127.0.0.1:${info.port}/`, 'GET');
      expect(htmlRes.statusCode).toBe(200);
      expect(htmlRes.body).toContain('<link rel="icon" type="image/png"');
      expect(htmlRes.body).toContain('href="data:image/png;base64,');
      expect(htmlRes.body).toContain('<link rel="shortcut icon" type="image/png" href="/favicon.png">');

      // 2. Check /favicon.png
      const pngRes = await makeHttpRequest(`http://127.0.0.1:${info.port}/favicon.png`, 'GET');
      expect(pngRes.statusCode).toBe(200);
      expect(pngRes.headers['content-type']).toBe('image/png');
      expect(parseInt(pngRes.headers['content-length'] || '0', 10)).toBe(2954);

      // 3. Check /favicon.ico
      const icoRes = await makeHttpRequest(`http://127.0.0.1:${info.port}/favicon.ico`, 'GET');
      expect(icoRes.statusCode).toBe(200);
      expect(icoRes.headers['content-type']).toBe('image/png');
      expect(parseInt(icoRes.headers['content-length'] || '0', 10)).toBe(2954);
    } finally {
      await hud.stop();
    }
  });
});
