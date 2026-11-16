import http from 'http';
import { URL } from 'url';
import { ProfitThresholdManager, VALID_PROFIT_THRESHOLDS_CENTS } from '../profit/profitThresholdManager.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';
import { HudV2Payload, HourlyProfitabilityBucket } from '../types/index.js';
import { formatQatarTime, formatQatarHour } from '../study/windowTracker.js';
import { SOLANA_FAVICON_PNG_BASE64 } from './faviconBase64.js';

const FAVICON_BUFFER = Buffer.from(SOLANA_FAVICON_PNG_BASE64, 'base64');

export interface ProfitHudServerOptions {
  port?: number;
  host?: string;
  silent?: boolean;
}

export class ProfitHudServer {
  private server: http.Server | null = null;
  private thresholdManager: ProfitThresholdManager;
  private scanner?: ArbitrageScanner;
  private port: number;
  private host: string;
  private boundPort: number | null = null;
  private silent: boolean;
  private isWsReconnecting = false;

  constructor(
    thresholdManager: ProfitThresholdManager,
    scanner?: ArbitrageScanner,
    options: ProfitHudServerOptions = {}
  ) {
    this.thresholdManager = thresholdManager;
    this.scanner = scanner;
    this.port = options.port ?? (process.env.HUD_PORT ? parseInt(process.env.HUD_PORT, 10) : 3030);
    this.host = '127.0.0.1'; // Strictly bound to 127.0.0.1 (never expose public or remote endpoint)
    this.silent = options.silent ?? false;
  }

  /**
   * Starts the localhost HTTP HUD server.
   * If the target port is occupied (EADDRINUSE), rejects immediately with a clear actionable error.
   */
  public async start(): Promise<{ port: number; host: string; url: string }> {
    if (this.server) {
      return {
        port: this.boundPort || this.port,
        host: this.host,
        url: `http://${this.host}:${this.boundPort || this.port}`
      };
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          const occupiedErr = new Error(
            `HUD port ${this.port} is already occupied by another process. Ensure no other instance is running or configure a different HUD_PORT.`
          );
          (occupiedErr as any).code = 'EADDRINUSE';
          if (!this.silent) {
            console.error(`[ProfitHudServer] FATAL: ${occupiedErr.message}`);
          }
          this.server = null;
          this.boundPort = null;
          reject(occupiedErr);
          return;
        }

        if (!this.silent) {
          console.error('[ProfitHudServer] Server error:', err);
        }
        this.server = null;
        this.boundPort = null;
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.boundPort = addr.port;
        } else {
          this.boundPort = this.port;
        }

        const url = `http://${this.host}:${this.boundPort}`;
        if (!this.silent) {
          console.log(`[ProfitHudServer] HUD active at ${url} [READ-ONLY / SHADOW MODE]`);
        }
        resolve({ port: this.boundPort, host: this.host, url });
      });
    });
  }

  /**
   * Stops the HTTP HUD server.
   */
  public async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.server = null;
        this.boundPort = null;
        resolve();
      });
    });
  }

  public getPort(): number | null {
    return this.boundPort;
  }

  public getUrl(): string {
    return `http://${this.host}:${this.boundPort || this.port}`;
  }

  /**
   * Returns authoritative allowed origins for localhost security.
   */
  public getAllowedOrigins(): Set<string> {
    const port = this.boundPort || this.port;
    return new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`
    ]);
  }

  /**
   * Validates that state-changing requests originate strictly from the local HUD (127.0.0.1 / localhost).
   * Verifies both Host header and Origin/Referer headers without reflecting arbitrary origins.
   */
  public isValidOriginAndHost(req: http.IncomingMessage): boolean {
    const port = this.boundPort || this.port;
    const allowedOrigins = this.getAllowedOrigins();
    const allowedHosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `127.0.0.1`,
      `localhost`
    ]);

    const host = req.headers['host'];
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      return false;
    }

    const origin = req.headers['origin'];
    if (origin) {
      if (!allowedOrigins.has(origin.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Fallback HUD V2 dataset for cold standby mode when scanner is not attached.
   */
  private getStandbyHudV2Data(): HudV2Payload {
    const thresholdUSDC = this.thresholdManager.getThresholdUSDC();
    const mem = process.memoryUsage();
    return {
      success: true,
      mode: 'READ-ONLY / SHADOW MODE',
      scannerStatus: 'STANDBY',
      scannerOnline: false,
      solanaSlot: null,
      wsConnected: false,
      wsStatus: 'STANDBY',
      rpcStatus: 'STANDBY',
      sessionUptimeFormatted: '00:00:00',
      lastSuccessfulUpdateTimestamp: Date.now(),
      thresholdUSDC,
      thresholdCents: Math.round(thresholdUSDC * 100),
      formattedThreshold: this.thresholdManager.getFormattedThreshold(),
      safetyBufferUSDC: 0.25,
      sharedVirtualCapitalUSDC: 1000,
      profitMonitor: {
        grossPositiveOpportunities: 0,
        netPositiveOpportunities: 0,
        qualifiedShadowSignals: 0,
        revalidatedSurvivingSignals: 0,
        bestConservativeNetUSDC: 0,
        shadowNetUSDCPerMinute: 0,
        realizedProfitUSDC: 0
      },
      profitWatchTable: [],
      performance: {
        routeEvaluationsPerSec: 0,
        quoteCalculationsPerSec: 0,
        totalEvaluationsSession: 0,
        quoteValidEvaluations: 0,
        quoteValidPercentage: 0,
        accountUpdatesPerSec: 0,
        eventQueueDepth: 0,
        eventQueueDrops: 0,
        queueWaitP95Us: 0,
        quoteCalculationP95Us: 0,
        rpcLatencyP95Ms: 0
      },
      routeHealth: {
        totalStoredUniquePools: 0,
        verifiedDirectPools: 0,
        totalUnique2LegRoutes: 0,
        verifiedRoutes: 0,
        readyRoutes: 0,
        staleRoutes: 0,
        blockedRoutes: 0,
        unvalidatedRoutes: 0,
        readyRouteUptimePercent: 0,
        wsConnectivityUptimePercent: 100,
        accountSubscriptionCoveragePercent: 100,
        verifiedPoolCoveragePercent: 0,
        quoteProducingScannerUptimePercent: 0
      },
      historicalVsSession: {
        historical: {
          totalStoredPools: 'N/A',
          verifiedStoredPools: 'N/A',
          unverifiedStoredPools: 'N/A',
          totalStoredRoutes: 'N/A',
          lastCompletedScoutRun: 'N/A'
        },
        session: {
          sessionStartTime: Date.now(),
          sessionUptimeMs: 0,
          newUniquePoolsDiscovered: 0,
          newVerifiedPools: 0,
          rejectedPoolCandidates: 0,
          newUniqueRoutesGenerated: 0,
          scoutStatus: 'IDLE',
          scoutLatestResult: 'None'
        }
      },
      rejectionAnalysis: {
        categories: [
          { category: 'EXCESSIVE_PRICE_IMPACT', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 },
          { category: 'SLOT_MISMATCH', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 },
          { category: 'STALE_QUOTE', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 },
          { category: 'WS_DISCONNECTED', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 },
          { category: 'LOW_CONSERVATIVE_NET', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 },
          { category: 'INSUFFICIENT_LIQUIDITY', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 },
          { category: 'OTHER', sessionCount: 0, sessionPercentage: 0, rolling60sCount: 0 }
        ],
        mostCommonBlocker: 'NONE',
        totalSessionRejections: 0,
        totalRolling60sRejections: 0
      },
      diagnostics: {
        wsReconnectAttempts: 0,
        lastMessageAgeMs: 0,
        lastSuccessfulReconnectTime: null,
        rpcFailures: 0,
        persistenceErrors: 0,
        eventLoopDelayMs: 0,
        processMemory: {
          rssMb: Math.round(mem.rss / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024)
        },
        sessionUptimeSeconds: 0
      },
      scout: null,
      study: {
        sessionId: 'STANDBY',
        status: 'STANDBY',
        startedAt: Date.now(),
        targetDurationMs: 86400000,
        profitHurdleUSDC: 0.10,
        elapsedMs: 0,
        healthyUptimeMs: 0,
        feedDowntimeMs: 0,
        disconnectCount: 0,
        totalQualifiedWindows: 0,
        openQualifiedWindows: 0,
        completedQualifiedWindows: 0,
        censoredWindows: 0,
        revalidationSuccessPct: null,
        minDurationMs: 0,
        medianDurationMs: 0,
        p95DurationMs: 0,
        maxDurationMs: 0,
        bestConservativeNetUSDC: 0,
        totalObservedShadowOpportunities: 0,
        liveWindows: [],
        closedWindows: [],
        nearMissesCount: 0,
        hourlyBuckets: (() => {
          const buckets: HourlyProfitabilityBucket[] = [];
          const now = Date.now();
          for (let h = 0; h < 24; h++) {
            const start = now + h * 3600000;
            const end = start + 3600000;
            buckets.push({
              hourIndex: h,
              hourStartUtc: new Date(start).toISOString(),
              hourStartQatar: formatQatarTime(start, false),
              hourLabel: `Hour ${h} (${formatQatarHour(start)})`,
              timeRangeQatar: `${formatQatarHour(start)} - ${formatQatarHour(end)}`,
              uniqueWindowsCount: 0,
              bestConservativeNetUSDC: 0,
              medianObservedDurationMs: 0,
              revalidationSuccessPct: null,
              healthyCoveragePct: null,
              healthyUptimeMs: 0,
              feedDowntimeMs: 0,
              disconnectCount: 0,
              status: 'FUTURE'
            });
          }
          return buckets;
        })(),
        mostActiveHours: []
      }
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.boundPort || this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    const allowedOrigins = this.getAllowedOrigins();
    const originHeader = req.headers['origin'];
    const defaultOrigin = `http://${this.host}:${this.boundPort || this.port}`;

    // Never reflect arbitrary foreign origins in CORS responses
    const corsOrigin = originHeader && allowedOrigins.has(originHeader.toLowerCase())
      ? originHeader
      : defaultOrigin;

    // CORS & Security Headers (Restricted to localhost)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Prevent an old HUD page or stale telemetry being reused by browser/proxy caches.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Solanabot-HUD-Version', 'V2');

    if (method === 'OPTIONS') {
      if (originHeader && !allowedOrigins.has(originHeader.toLowerCase())) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Forbidden: CORS origin not allowed' }));
        return;
      }

      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // Favicon: GET /favicon.ico and GET /favicon.png
    if ((pathname === '/favicon.ico' || pathname === '/favicon.png') && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': FAVICON_BUFFER.length,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': corsOrigin
      });
      res.end(FAVICON_BUFFER);
      return;
    }

    // 1. GET /api/threshold
    if (pathname === '/api/threshold' && method === 'GET') {
      const payload = {
        success: true,
        mode: 'READ-ONLY / SHADOW MODE',
        thresholdUSDC: this.thresholdManager.getThresholdUSDC(),
        thresholdCents: this.thresholdManager.getThresholdCents(),
        formatted: this.thresholdManager.getFormattedThreshold(),
        minUSDC: 0.10,
        maxUSDC: 0.70,
        stepUSDC: 0.05,
        allowedStepsUSDC: VALID_PROFIT_THRESHOLDS_CENTS.map(c => c / 100)
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin
      });
      res.end(JSON.stringify(payload));
      return;
    }

    // 2. POST /api/threshold (Live runtime adjustment)
    if (pathname === '/api/threshold' && method === 'POST') {
      // Security: Origin and Host validation
      if (!this.isValidOriginAndHost(req)) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': defaultOrigin
        });
        res.end(JSON.stringify({
          success: false,
          error: 'Forbidden: State-changing requests restricted strictly to 127.0.0.1 / localhost Origin and Host'
        }));
        return;
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) {
          req.destroy();
        }
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const candidateVal = parsed.thresholdUSDC !== undefined
            ? parsed.thresholdUSDC
            : (parsed.cents !== undefined ? parsed.cents : undefined);

          const result = this.thresholdManager.setThreshold(candidateVal);

          if (!result.success) {
            const isPersistenceFailure = result.error?.includes('Persistence failure');
            const statusCode = isPersistenceFailure ? 500 : 400;

            res.writeHead(statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': corsOrigin
            });
            res.end(JSON.stringify({
              success: false,
              error: result.error,
              thresholdUSDC: result.thresholdUSDC,
              thresholdCents: result.thresholdCents,
              formatted: result.formatted
            }));
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': corsOrigin
          });
          res.end(JSON.stringify({
            success: true,
            thresholdUSDC: result.thresholdUSDC,
            thresholdCents: result.thresholdCents,
            formatted: result.formatted,
            mode: 'READ-ONLY / SHADOW MODE'
          }));
        } catch (err) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': corsOrigin
          });
          res.end(JSON.stringify({
            success: false,
            error: `Malformed JSON request payload: ${err instanceof Error ? err.message : String(err)}`,
            thresholdUSDC: this.thresholdManager.getThresholdUSDC(),
            thresholdCents: this.thresholdManager.getThresholdCents(),
            formatted: this.thresholdManager.getFormattedThreshold()
          }));
        }
      });
      return;
    }

    // 3. GET /api/status (Live telemetry, active signal counts & complete HUD V2 payload)
    if (pathname === '/api/status' && method === 'GET') {
      const isScannerPresent = !!this.scanner;
      const hudData = (this.scanner && typeof this.scanner.getHudV2Data === 'function')
        ? this.scanner.getHudV2Data()
        : this.getStandbyHudV2Data();

      const tracker = (this.scanner && typeof this.scanner.getOpportunityTracker === 'function')
        ? this.scanner.getOpportunityTracker()
        : null;
      const activeOpportunities = tracker ? tracker.getAllActiveOpportunities() : [];
      const qualifiedActiveShadow = activeOpportunities.filter(o => o.status === 'QUALIFIED_SHADOW');
      const health = (this.scanner && typeof this.scanner.getHealthStatus === 'function')
        ? this.scanner.getHealthStatus()
        : null;

      let wsStatus = hudData.wsStatus;
      if (this.isWsReconnecting) {
        wsStatus = 'RECONNECTING';
      }

      // Scanner status compatibility: tests assert data.scannerStatus === 'ONLINE' when scanner is present,
      // or 'STANDBY' when scanner is absent. We also provide scannerState for HUD V2 ('RUNNING' | 'DEGRADED' | 'OFFLINE' | 'STANDBY').
      const scannerStatus = isScannerPresent ? 'ONLINE' : 'STANDBY';
      let scannerState: 'RUNNING' | 'DEGRADED' | 'OFFLINE' | 'STANDBY' = 'STANDBY';
      if (isScannerPresent) {
        const isRunning = typeof this.scanner?.isScannerRunning === 'function' ? this.scanner.isScannerRunning() : true;
        const isInitialized = typeof (this.scanner as any)?.isScannerInitialized === 'function' ? (this.scanner as any).isScannerInitialized() : true;
        if (!isRunning) {
          scannerState = 'OFFLINE';
        } else if (!isInitialized) {
          scannerState = 'STANDBY';
        } else if (!health?.connectedWs || !health?.connectedRpc) {
          scannerState = 'DEGRADED';
        } else {
          scannerState = 'RUNNING';
        }
      }

      const payload: any = {
        ...hudData,
        scannerStatus,
        scannerState,
        scannerOnline: isScannerPresent ? (typeof (this.scanner as any)?.isScannerInitialized === 'function' ? (this.scanner as any).isScannerInitialized() : true) : false,
        initializationStage: (this.scanner && typeof (this.scanner as any)?.getInitializationStage === 'function') ? (this.scanner as any).getInitializationStage() : undefined,
        wsStatus,
        wsConnected: wsStatus === 'CONNECTED' || wsStatus === 'HEALTHY',
        // Legacy compat fields
        qualifiedCount: health ? health.qualifiedCount : 0,
        rejectedCount: health ? health.rejectedCount : 0,
        activeAllocatedCapitalUSDC: tracker ? tracker.getActiveAllocatedCapital() : 0,
        activeShadowSignalsCount: qualifiedActiveShadow.length,
        routeLibrary: (this.scanner && typeof this.scanner.getRouteLibrarySummary === 'function')
          ? this.scanner.getRouteLibrarySummary()
          : null,
      };

      if (this.scanner && typeof this.scanner.getScoutMetrics === 'function') {
        payload.scout = this.scanner.getScoutMetrics();
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin
      });
      res.end(JSON.stringify(payload));
      return;
    }

    // 4. POST /api/scout/trigger (Manual Scout discovery trigger)
    if (pathname === '/api/scout/trigger' && method === 'POST') {
      if (!this.isValidOriginAndHost(req)) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': defaultOrigin
        });
        res.end(JSON.stringify({
          success: false,
          error: 'Forbidden: State-changing requests restricted strictly to 127.0.0.1 / localhost Origin and Host'
        }));
        return;
      }

      if (!this.scanner) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: false,
          error: 'Scanner not connected'
        }));
        return;
      }

      try {
        const result = await this.scanner.triggerScoutDiscovery('MANUAL');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: true,
          result,
          metrics: this.scanner.getScoutMetrics()
        }));
      } catch (err: any) {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: false,
          error: err.message || String(err)
        }));
      }
      return;
    }

    // 5. POST /api/ws/reconnect (Manual WebSocket reconnect trigger)
    if (pathname === '/api/ws/reconnect' && method === 'POST') {
      if (!this.isValidOriginAndHost(req)) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': defaultOrigin
        });
        res.end(JSON.stringify({
          success: false,
          error: 'Forbidden: State-changing requests restricted strictly to 127.0.0.1 / localhost Origin and Host'
        }));
        return;
      }

      if (!this.scanner) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: false,
          wsStatus: 'STANDBY',
          error: 'Scanner not connected'
        }));
        return;
      }

      if (this.isWsReconnecting) {
        res.writeHead(409, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: false,
          wsStatus: 'RECONNECTING',
          error: 'WebSocket reconnection already in progress'
        }));
        return;
      }

      this.isWsReconnecting = true;
      try {
        const outcome = await this.scanner.reconnectWebSocket();
        const statusCode = outcome.success ? 200 : 502;
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: outcome.success,
          wsStatus: outcome.status,
          slot: outcome.slot,
          durationMs: outcome.durationMs,
          error: outcome.error
        }));
      } catch (err: any) {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin
        });
        res.end(JSON.stringify({
          success: false,
          wsStatus: 'FAILED',
          error: err?.message || String(err)
        }));
      } finally {
        this.isWsReconnecting = false;
      }
      return;
    }

    // 6. GET / (Professional Crypto Arbitrage Trading Terminal HUD V2)
    if (pathname === '/' && method === 'GET') {
      const html = this.renderHtmlDashboard();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));
  }

  /**
   * Renders the complete SolanaBot Monitoring HUD V2 trading terminal.
   * Zero external front-end libraries or frameworks. Pure HTML5 / CSS3 / Vanilla JS.
   */
  private renderHtmlDashboard(): string {
    const currentUSDC = this.thresholdManager.getThresholdUSDC().toFixed(2);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <link rel="icon" type="image/png" href="data:image/png;base64,${SOLANA_FAVICON_PNG_BASE64}">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>SolanaBot HUD V2 - Crypto Arbitrage Trading Terminal</title>
  <style>
    :root {
      --bg-darkest: #07090e;
      --bg-main: #0b0f17;
      --bg-card: #111722;
      --bg-card-hover: #161e2c;
      --bg-subtle: #172030;
      --border: #1f293d;
      --border-bright: #2d3b55;
      --text: #c5d1e0;
      --text-muted: #798a9f;
      --text-bright: #f0f4f8;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.15);
      --green-border: rgba(16, 185, 129, 0.4);
      --red: #ef4444;
      --red-glow: rgba(239, 68, 68, 0.15);
      --red-border: rgba(239, 68, 68, 0.4);
      --amber: #f59e0b;
      --amber-glow: rgba(245, 158, 11, 0.15);
      --amber-border: rgba(245, 158, 11, 0.4);
      --blue: #38bdf8;
      --blue-glow: rgba(56, 189, 248, 0.15);
      --blue-border: rgba(56, 189, 248, 0.4);
      --font-mono: "SF Mono", "Fira Code", "Roboto Mono", Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-main);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
      padding-bottom: 40px;
    }

    /* Top Sticky Status Bar */
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 1000;
      background-color: rgba(7, 9, 14, 0.94);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .brand-section {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-title {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: var(--text-bright);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .brand-title span.v2 {
      color: var(--blue);
      font-size: 13px;
      padding: 2px 6px;
      background: var(--blue-glow);
      border: 1px solid var(--blue-border);
      border-radius: 4px;
    }
    .badge-shadow {
      background-color: var(--amber-glow);
      color: var(--amber);
      border: 1px solid var(--amber-border);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .top-statuses {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .status-group {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
    }
    .status-label {
      color: var(--text-muted);
      text-transform: uppercase;
      font-size: 10px;
      font-weight: 600;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
      font-family: var(--font-mono);
    }
    .status-online {
      background: var(--green-glow);
      color: var(--green);
      border: 1px solid var(--green-border);
    }
    .status-standby {
      background: var(--amber-glow);
      color: var(--amber);
      border: 1px solid var(--amber-border);
    }
    .status-offline {
      background: var(--red-glow);
      color: var(--red);
      border: 1px solid var(--red-border);
    }
    .btn-ws {
      background-color: var(--bg-subtle);
      color: var(--text-bright);
      border: 1px solid var(--border-bright);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.4px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-ws:hover {
      background-color: var(--border-bright);
      border-color: var(--blue);
      color: #fff;
    }
    .btn-ws:disabled {
      background-color: var(--bg-card);
      border-color: var(--border);
      color: var(--text-muted);
      cursor: not-allowed;
    }

    /* Offline Banner */
    .offline-banner {
      background: linear-gradient(90deg, rgba(239,68,68,0.2) 0%, rgba(239,68,68,0.3) 50%, rgba(239,68,68,0.2) 100%);
      border-bottom: 1px solid var(--red-border);
      color: #ff8585;
      text-align: center;
      padding: 8px 16px;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.5px;
      display: none;
    }

    /* Container Layout */
    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 16px 20px;
    }

    /* Section Cards */
    .card {
      background-color: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 16px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .card-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-bright);
      letter-spacing: 0.3px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Hero Section: Live Profit Monitor */
    .hero-container {
      background: linear-gradient(180deg, #121824 0%, #0d121c 100%);
      border: 1px solid #233048;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    }
    .hero-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .hero-card {
      background: rgba(11, 15, 23, 0.7);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .hero-card:hover {
      border-color: var(--border-bright);
    }
    .hero-card.highlight {
      border-color: var(--green-border);
      background: linear-gradient(180deg, rgba(16,185,129,0.06) 0%, rgba(11,15,23,0.7) 100%);
    }
    .hero-card-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .hero-card-value {
      font-size: 26px;
      font-weight: 800;
      color: var(--text-bright);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .hero-card-value.green {
      color: var(--green);
      text-shadow: 0 0 12px rgba(16, 185, 129, 0.3);
    }
    .hero-card-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .hero-sub-bar {
      background: rgba(7, 9, 14, 0.6);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 12px;
    }
    .hero-sub-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hero-sub-item strong {
      color: var(--text-bright);
      font-family: var(--font-mono);
    }

    /* Profit Watch Table */
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-darkest);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
    }
    th {
      background-color: #0f1522;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #141b28;
      font-family: var(--font-mono);
      white-space: nowrap;
    }
    tbody tr {
      cursor: pointer;
      transition: background-color 0.15s;
    }
    tbody tr:nth-child(4n+1) {
      background-color: #0c1018;
    }
    tbody tr:nth-child(4n+3) {
      background-color: #0f1420;
    }
    tbody tr:hover {
      background-color: var(--bg-card-hover) !important;
    }
    tbody tr.selected {
      background-color: #1a2538 !important;
      border-left: 3px solid var(--blue);
    }
    .detail-row {
      display: none;
      background-color: #0a0e16 !important;
    }
    .detail-row.expanded {
      display: table-row;
    }
    .detail-content {
      padding: 14px 20px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      font-size: 11px;
      line-height: 1.6;
      border-bottom: 1px solid var(--border-bright);
    }
    .detail-item {
      background: #111724;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
    }
    .detail-label {
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      margin-bottom: 2px;
    }
    .detail-val {
      color: var(--text-bright);
      word-break: break-all;
      font-family: var(--font-mono);
    }

    /* Badges & Metrics */
    .badge-qual {
      background: var(--green-glow);
      color: var(--green);
      border: 1px solid var(--green-border);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 10px;
    }
    .badge-near {
      background: var(--amber-glow);
      color: var(--amber);
      border: 1px solid var(--amber-border);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 10px;
    }
    .badge-rej {
      background: var(--red-glow);
      color: var(--red);
      border: 1px solid var(--red-border);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 10px;
    }

    /* Multi-Column Grid */
    .two-col-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 900px) {
      .two-col-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
    }
    .stat-box {
      background: var(--bg-darkest);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
    }
    .stat-box-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .stat-box-val {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-bright);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    /* Route Health States Bar */
    .states-bar-container {
      margin-top: 10px;
      background: var(--bg-darkest);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      font-size: 11px;
    }
    .state-pill {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .state-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    /* Rejection Analysis Table */
    .rejection-summary-bar {
      background: #141b27;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }

    /* Slider & Controls */
    .slider-box {
      background: var(--bg-darkest);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-top: 8px;
    }
    input[type=range] {
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: #1e283a;
      outline: none;
      -webkit-appearance: none;
      cursor: pointer;
      margin: 12px 0 6px 0;
    }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--blue);
      cursor: pointer;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.6);
      transition: transform 0.1s;
    }
    input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15);
    }
    .ticks {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .btn-scout {
      background-color: #1f6feb;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .btn-scout:hover {
      background-color: #388bfd;
    }
    .btn-scout:disabled {
      background-color: var(--bg-subtle);
      color: var(--text-muted);
      cursor: not-allowed;
    }

    /* Alerts */
    .alert {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 12px;
      margin-top: 10px;
      display: none;
    }
    .alert-success {
      background-color: var(--green-glow);
      border: 1px solid var(--green-border);
      color: #6ee7b7;
    }
    .alert-error {
      background-color: var(--red-glow);
      border: 1px solid var(--red-border);
      color: #fca5a5;
    }

    /* Footer */
    .footer {
      text-align: center;
      margin-top: 30px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
    }
  </style>
</head>
<body>

  <!-- Top Sticky Status Bar (Section 1) -->
  <header class="top-bar">
    <div class="brand-section">
      <div class="brand-title">SOLANABOT <span class="v2">HUD V2</span></div>
      <span class="badge-shadow">READ-ONLY / SHADOW MODE</span>
    </div>

    <div class="top-statuses">
      <div class="status-group">
        <span class="status-label">Scanner:</span>
        <span id="telemetryScannerStatus" class="status-badge status-standby">STANDBY</span>
      </div>

      <div class="status-group">
        <span class="status-label">RPC:</span>
        <span id="rpcStatusBadge" class="status-badge status-standby">STANDBY</span>
      </div>

      <div class="status-group">
        <span class="status-label">WS:</span>
        <span id="telemetryWsBadge" class="status-badge status-standby">STANDBY</span>
      </div>

      <div class="status-group" style="display: flex; align-items: center; gap: 8px;">
        <span class="status-label" style="display:none;">RPC / WebSocket</span>
        <span id="telemetryNetwork" style="display:none;">STANDBY / STANDBY</span>
        <button id="btnReconnectWs" class="btn-ws" type="button" title="Reconnect Solana RPC WebSocket feed">RECONNECT WEBSOCKET</button>
      </div>

      <div class="status-group">
        <span class="status-label">Slot:</span>
        <span id="telemetrySlot" style="font-family: var(--font-mono); font-weight:700; color:var(--blue);">--</span>
      </div>

      <div class="status-group">
        <span class="status-label">Uptime:</span>
        <span id="telemetryUptime" style="font-family: var(--font-mono); color:var(--text-bright);">00:00:00</span>
      </div>

      <div class="status-group">
        <span class="status-label">Updated:</span>
        <span id="telemetryLastUpdated" style="font-family: var(--font-mono); color:var(--text-bright);">--:--:--</span>
      </div>
    </div>
  </header>

  <!-- Offline Alert Banner (Section 10) -->
  <div id="offlineBanner" class="offline-banner">
    WARNING: BACKEND OFFLINE &bull; DISPLAYING STALE CACHED DATA &bull; LAST SEEN: <span id="offlineLastSeen">--</span>
  </div>

  <main class="container">
    <div id="wsAlert" class="alert"></div>

    <!-- Section 2: Live Profit Monitor (Hero Section) -->
    <section class="hero-container" id="telemetryCard">
      <div class="hero-header">
        <div>
          <div style="font-size: 16px; font-weight: 800; color: #fff; letter-spacing: 0.5px; display:flex; align-items:center; gap:8px;">
            <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:var(--green); box-shadow:0 0 8px var(--green);"></span>
            LIVE PROFIT MONITOR
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
            2-Leg Solana Arbitrage &bull; Evaluated against live DEX quotes with conservative netting and safety buffer
          </div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase;">Realized Profit (Shadow Mode)</div>
          <div style="font-size: 18px; font-weight: 800; color: var(--text-muted); font-family: var(--font-mono);">$0.00 USDC</div>
        </div>
      </div>

      <!-- 6 Hero Cards -->
      <div class="hero-grid">
        <div class="hero-card">
          <div class="hero-card-label">Gross-Positive</div>
          <div class="hero-card-value" id="statGrossPositive">0</div>
          <div class="hero-card-sub">Pre-cost spread divergence</div>
        </div>

        <div class="hero-card">
          <div class="hero-card-label">Net-Positive</div>
          <div class="hero-card-value" id="statNetPositive">0</div>
          <div class="hero-card-sub">Covering fees & priority</div>
        </div>

        <div class="hero-card">
          <div class="hero-card-label">Qualified Shadow</div>
          <div class="hero-card-value" id="statQualifiedShadow">0</div>
          <div class="hero-card-sub">Conservative net &ge; hurdle</div>
        </div>

        <div class="hero-card">
          <div class="hero-card-label">Revalidated Surviving</div>
          <div class="hero-card-value" id="statRevalidatedSurviving">0</div>
          <div class="hero-card-sub">Passed pre-execution recheck</div>
        </div>

        <div class="hero-card highlight">
          <div class="hero-card-label">Best Conservative Net</div>
          <div class="hero-card-value green" id="statBestConservativeNet">+$0.0000</div>
          <div class="hero-card-sub">Peak valid session opportunity</div>
        </div>

        <div class="hero-card highlight">
          <div class="hero-card-label">Shadow Net USDC / Min</div>
          <div class="hero-card-value green" id="statShadowNetRate">+$0.0000</div>
          <div class="hero-card-sub">Rolling 60s qualified net yield</div>
        </div>
      </div>

      <div class="hero-sub-bar">
        <div class="hero-sub-item">
          <span style="color:var(--text-muted);">Active Hurdle Floor:</span>
          <strong id="statActiveHurdle">$${currentUSDC} USDC</strong>
        </div>
        <div class="hero-sub-item">
          <span style="color:var(--text-muted);">Shared Virtual Capital:</span>
          <strong id="statVirtualCapital">$1,000.00 USDC</strong>
        </div>
        <div class="hero-sub-item">
          <span style="color:var(--text-muted);">Active Shadow Allocation:</span>
          <strong id="telemetryCapital">$0.00 USDC</strong>
        </div>
        <div class="hero-sub-item">
          <span style="color:var(--text-muted);">Active Signals:</span>
          <strong id="telemetrySignals">0</strong>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); width: 100%; margin-top: 4px;">
          <em>* Conservative Net applies minimal pool outAmount, maximum slippage tolerance, priority gas fee, and $0.25 safety buffer.</em>
        </div>
      </div>
    </section>

    <!-- Section 3: Top 10 Profit Watch Table -->
    <section class="card">
      <div class="card-header">
        <div>
          <div class="card-title">TOP 10 PROFIT WATCH</div>
          <div class="card-subtitle">Real-time candidate buffer ranked by qualification, conservative net profit, and quote freshness. Click any row to inspect 11 routing & cost fields.</div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">Bounded buffer (max 10 displayed)</div>
      </div>

      <div class="table-container">
        <table id="profitWatchTable">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Token</th>
              <th>Buy DEX</th>
              <th>Sell DEX</th>
              <th>Trade Size</th>
              <th>Gross Spread</th>
              <th>Expected Net</th>
              <th>Conservative Net</th>
              <th>Shortfall</th>
              <th>Quote Age</th>
              <th>Status / Reason</th>
            </tr>
          </thead>
          <tbody id="profitWatchTbody">
            <tr>
              <td colspan="11" style="text-align: center; color: var(--text-muted); padding: 24px;">
                Waiting for route evaluations... Polling live DEX pool states.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Section: 24-Hour Profitability Study -->
    <section class="card" id="studyCard">
      <div class="card-header">
        <div>
          <div class="card-title">
            <span id="studyStatusDot" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--blue); box-shadow:0 0 6px var(--blue);"></span>
            24-HOUR PROFITABILITY &amp; OPPORTUNITY WINDOW STUDY
            <span id="studyStatusBadge" class="status-badge status-standby" style="margin-left: 8px;">STANDBY</span>
          </div>
          <div class="card-subtitle">
            Continuous 24h shadow mainnet scan &bull; Window duration tracking, deduplication &amp; closure analysis &bull; Fail-closed on feed downtime
          </div>
        </div>
        <div style="text-align: right; font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">
          Session: <strong id="studySessionId" style="color:var(--text-bright);">STANDBY</strong> &bull; Hurdle: <strong id="studyHurdle" style="color:var(--green);">$0.10 USDC</strong>
        </div>
      </div>

      <!-- Study Hero Metrics -->
      <div class="stats-grid" style="margin-bottom: 16px;">
        <div class="stat-box">
          <div class="stat-box-label">Elapsed / Target (24h)</div>
          <div class="stat-box-val" id="studyElapsed" style="color:var(--blue);">00:00:00 / 24:00:00</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Healthy Scan Uptime</div>
          <div class="stat-box-val" id="studyHealthyUptime" style="color:var(--green);">00:00:00 (100%)</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Feed Downtime</div>
          <div class="stat-box-val" id="studyDowntime" style="color:var(--text-muted);">00:00:00 (0 drops)</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Qualified Windows</div>
          <div class="stat-box-val" id="studyQualifiedWindows">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Revalidation Survival</div>
          <div class="stat-box-val" id="studyRevalRate">100.0%</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Duration Median / P95</div>
          <div class="stat-box-val" id="studyDurationMedP95">0ms / 0ms</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Duration Min / Max</div>
          <div class="stat-box-val" id="studyDurationMinMax">0ms / 0ms</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Best Conservative Net</div>
          <div class="stat-box-val" id="studyBestNet" style="color:var(--green);">+$0.0000</div>
        </div>
      </div>

      <!-- Hourly Analysis Sub-section -->
      <div style="margin-top: 18px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size: 13px; font-weight: 700; color: var(--text-bright); display:flex; align-items:center; gap:6px;">
          <span>&#128202;</span>
          24-HOUR HOURLY PROFITABILITY ANALYSIS (ASIA/QATAR - AST)
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">
          Hourly window distribution &bull; Median duration &bull; Revalidation survival &bull; Fail-closed on feed downtime
        </div>
      </div>

      <!-- 24-Hour Visual Hourly Bar Chart -->
      <div style="background: var(--bg-darkest); border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <span style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">
            24-Hour Opportunity Windows &amp; Feed Health (UTC+3)
          </span>
          <span style="font-size:10px; color:var(--text-muted); display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
            <span style="display:inline-flex; align-items:center; gap:4px;"><span style="width:8px; height:8px; border-radius:2px; background:var(--green); display:inline-block;"></span> Active Observed</span>
            <span style="display:inline-flex; align-items:center; gap:4px;"><span style="width:8px; height:8px; border-radius:2px; background:#2d3b55; display:inline-block;"></span> Zero Verified</span>
            <span style="display:inline-flex; align-items:center; gap:4px;"><span style="width:8px; height:8px; border-radius:2px; background:var(--amber); display:inline-block;"></span> Degraded</span>
            <span style="display:inline-flex; align-items:center; gap:4px;"><span style="width:8px; height:8px; border-radius:2px; background:var(--red); display:inline-block;"></span> Disconnected</span>
            <span style="display:inline-flex; align-items:center; gap:4px;"><span style="width:8px; height:8px; border-radius:2px; background:#141b29; display:inline-block;"></span> Future</span>
          </span>
        </div>
        <div id="studyHourlyChart" style="display:flex; align-items:flex-end; gap:3px; height:64px; padding-top:6px; border-bottom:1px solid var(--border);">
          <!-- 24 bars inserted dynamically -->
        </div>
        <div id="studyHourlyLabels" style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-muted); margin-top:4px; font-family:var(--font-mono);">
          <span>Hour 0</span>
          <span>Hour 6</span>
          <span>Hour 12</span>
          <span>Hour 18</span>
          <span>Hour 23</span>
        </div>
      </div>

      <!-- Hourly Profitability Table -->
      <div class="table-container" style="margin-bottom: 16px; max-height: 240px; overflow-y: auto;">
        <table id="studyHourlyTable">
          <thead>
            <tr>
              <th>Hour</th>
              <th>Time Range (AST)</th>
              <th>Windows</th>
              <th>Best Net (USDC)</th>
              <th>Median Observed Dur</th>
              <th>Revalidation %</th>
              <th>Healthy Coverage %</th>
              <th>Monitoring Status</th>
            </tr>
          </thead>
          <tbody id="studyHourlyTbody">
            <tr>
              <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 14px;">
                Hourly profitability data will stream continuously during the 24-hour study.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Most Active Profitable Hours Sub-section -->
      <div style="margin-top: 14px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size: 13px; font-weight: 700; color: var(--text-bright); display:flex; align-items:center; gap:6px;">
          <span style="color:var(--green);">&#9733;</span>
          MOST ACTIVE PROFITABLE HOURS (VERIFIED OBSERVATIONS ONLY)
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">
          Ranked strictly on observed shadow opportunities with healthy coverage (&ge;50%). Disconnected periods excluded.
        </div>
      </div>

      <div class="table-container" style="margin-bottom: 16px;">
        <table id="studyActiveHoursTable">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Hour</th>
              <th>Time Range (AST)</th>
              <th>Unique Windows</th>
              <th>Best Conservative Net</th>
              <th>Median Duration</th>
              <th>Healthy Coverage</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="studyActiveHoursTbody">
            <tr>
              <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 14px;">
                No active profitable hours confirmed yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Live Windows Sub-section -->
      <div style="margin-top: 14px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size: 13px; font-weight: 700; color: var(--text-bright); display:flex; align-items:center; gap:6px;">
          <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--green);"></span>
          LIVE PROFITABLE WINDOWS (ACTIVE)
          <span id="studyLiveCount" class="badge-qual" style="font-size:10px; margin-left:4px;">0</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">Active qualified market windows awaiting closure or recheck</div>
      </div>

      <div class="table-container" style="margin-bottom: 16px;">
        <table id="studyLiveTable">
          <thead>
            <tr>
              <th>Token</th>
              <th>Route</th>
              <th>Trade Size</th>
              <th>Opening Net</th>
              <th>Peak Net</th>
              <th>Live Duration</th>
              <th>Snapshots</th>
              <th>Revalidation</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="studyLiveTbody">
            <tr>
              <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 14px;">
                No currently open profitable opportunity windows.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Closed Windows Sub-section -->
      <div style="margin-top: 14px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size: 13px; font-weight: 700; color: var(--text-bright); display:flex; align-items:center; gap:6px;">
          <span>&#9201;</span>
          RECENT CLOSED / CENSORED WINDOWS
          <span id="studyClosedCount" class="badge-near" style="font-size:10px; margin-left:4px;">0</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">Observed duration vs closure interval &bull; Asia/Qatar timestamps</div>
      </div>

      <div class="table-container">
        <table id="studyClosedTable">
          <thead>
            <tr>
              <th>Token</th>
              <th>Route</th>
              <th>Trade Size</th>
              <th>Peak Net</th>
              <th>Observed Dur</th>
              <th>Closure Int</th>
              <th>First Seen (AST)</th>
              <th>Closed At (AST)</th>
              <th>Status &amp; Reason</th>
            </tr>
          </thead>
          <tbody id="studyClosedTbody">
            <tr>
              <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 14px;">
                No closed opportunity windows recorded yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Middle Grid: Performance & Health (Sections 4 & 5) -->
    <div class="two-col-grid">
      <!-- Section 4: Scanner Performance -->
      <section class="card">
        <div class="card-header">
          <div class="card-title">SCANNER PERFORMANCE & TELEMETRY</div>
          <div class="card-subtitle">Throughput, event loop latency, and p95 timings</div>
        </div>

        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-box-label">Route Evals / Sec</div>
            <div class="stat-box-val" id="perfRouteEvalsSec">0 /s</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Quote Calcs / Sec</div>
            <div class="stat-box-val" id="perfQuoteCalcsSec">0 /s</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Session Evaluations</div>
            <div class="stat-box-val" id="perfTotalEvals">0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Quote Valid %</div>
            <div class="stat-box-val" id="perfQuoteValid">0 (0.0%)</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Account Updates / Sec</div>
            <div class="stat-box-val" id="perfAccountUpdatesSec">0 /s</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Queue Depth / Drops</div>
            <div class="stat-box-val" id="perfQueueDepthDrops">0 / 0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Queue Wait p95</div>
            <div class="stat-box-val" id="perfQueueWaitP95">0.0 µs</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Quote Calc p95</div>
            <div class="stat-box-val" id="perfQuoteCalcP95">0.0 µs</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">RPC Latency p95</div>
            <div class="stat-box-val" id="perfRpcLatencyP95">0.0 ms</div>
          </div>
        </div>
      </section>

      <!-- Section 5: Route & Pool Health -->
      <section class="card">
        <div class="card-header">
          <div class="card-title">ROUTE & POOL HEALTH (2-LEG DIRECT)</div>
          <div class="card-subtitle">Topology library and mutually exclusive route readiness</div>
        </div>

        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-box-label">Stored Unique Pools</div>
            <div class="stat-box-val" id="healthStoredPools">0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Verified Direct Pools</div>
            <div class="stat-box-val" id="healthVerifiedPools">0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Unique 2-Leg Routes</div>
            <div class="stat-box-val" id="healthUniqueRoutes">0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">READY Route Uptime</div>
            <div class="stat-box-val" id="healthReadyUptime">0.0%</div>
          </div>
        </div>

        <div class="states-bar-container">
          <div class="state-pill">
            <span class="state-dot" style="background:#38bdf8;"></span>
            <span style="color:var(--text-muted);">VERIFIED:</span>
            <strong id="stateVerified" style="color:var(--text-bright); font-family:var(--font-mono);">0</strong>
          </div>
          <div class="state-pill">
            <span class="state-dot" style="background:#10b981;"></span>
            <span style="color:var(--text-muted);">READY:</span>
            <strong id="stateReady" style="color:#10b981; font-family:var(--font-mono);">0</strong>
          </div>
          <div class="state-pill">
            <span class="state-dot" style="background:#f59e0b;"></span>
            <span style="color:var(--text-muted);">STALE:</span>
            <strong id="stateStale" style="color:#f59e0b; font-family:var(--font-mono);">0</strong>
          </div>
          <div class="state-pill">
            <span class="state-dot" style="background:#ef4444;"></span>
            <span style="color:var(--text-muted);">BLOCKED:</span>
            <strong id="stateBlocked" style="color:#ef4444; font-family:var(--font-mono);">0</strong>
          </div>
          <div class="state-pill">
            <span class="state-dot" style="background:#6b7280;"></span>
            <span style="color:var(--text-muted);">UNVALIDATED:</span>
            <strong id="stateUnvalidated" style="color:#9ca3af; font-family:var(--font-mono);">0</strong>
          </div>
        </div>
      </section>
    </div>

    <!-- Section 6: Historical Database vs Session (Side-by-Side) -->
    <section class="card">
      <div class="card-header">
        <div class="card-title">HISTORICAL PERSISTENCE VS CURRENT SESSION</div>
        <div class="card-subtitle">Authoritative SQLite persistent records compared side-by-side with volatile session telemetry</div>
      </div>

      <div class="two-col-grid">
        <!-- Historical Column -->
        <div style="background: var(--bg-darkest); border: 1px solid var(--border); border-radius: 6px; padding: 14px;">
          <div style="font-size: 12px; font-weight: 700; color: var(--blue); margin-bottom: 10px; text-transform: uppercase;">
            Historical Persistence (SQLite)
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div class="stat-box">
              <div class="stat-box-label">Total Unique Pools</div>
              <div class="stat-box-val" id="histTotalPools">--</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">Verified Pools</div>
              <div class="stat-box-val" id="histVerifiedPools">--</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">Unverified Pools</div>
              <div class="stat-box-val" id="histUnverifiedPools">--</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">Total Stored Routes</div>
              <div class="stat-box-val" id="histTotalRoutes">--</div>
            </div>
          </div>
          <div style="margin-top: 10px; font-size: 11px; color: var(--text-muted);">
            Last Scout Run: <strong id="histLastScout" style="color: var(--text-bright); font-family: var(--font-mono);">N/A</strong>
          </div>
        </div>

        <!-- Session Column -->
        <div style="background: var(--bg-darkest); border: 1px solid var(--border); border-radius: 6px; padding: 14px;">
          <div style="font-size: 12px; font-weight: 700; color: var(--green); margin-bottom: 10px; text-transform: uppercase;">
            Current Session Telemetry
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div class="stat-box">
              <div class="stat-box-label">New Pools Discovered</div>
              <div class="stat-box-val" id="sessNewPools">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">New Verified Pools</div>
              <div class="stat-box-val" id="sessVerifiedPools">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">Rejected Candidates</div>
              <div class="stat-box-val" id="sessRejectedCandidates">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">New Routes Generated</div>
              <div class="stat-box-val" id="sessNewRoutes">0</div>
            </div>
          </div>
          <div style="margin-top: 10px; font-size: 11px; color: var(--text-muted); display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;">
            <div>Started: <strong id="sessStartTime" style="color: var(--text-bright); font-family: var(--font-mono);">--:--:--</strong></div>
            <div>Scout Status: <strong id="sessScoutStatus" style="color: var(--text-bright); font-family: var(--font-mono);">IDLE</strong></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Section 7: Rejection Analysis -->
    <section class="card">
      <div class="card-header">
        <div class="card-title">REJECTION ANALYSIS & PIPELINE BOTTLENECKS</div>
        <div class="card-subtitle">Session counts, percentage distribution, and rolling 60s activity across 7 standard categories</div>
      </div>

      <div class="rejection-summary-bar">
        <div>
          <span style="color:var(--text-muted);">Most Common Blocker:</span>
          <span id="rejectionMostCommon" class="status-badge status-standby" style="margin-left: 6px;">NONE</span>
        </div>
        <div style="font-family: var(--font-mono);">
          <span style="color:var(--text-muted);">Total Rejected:</span>
          <strong id="rejectionTotalSession">0</strong> session &bull; <strong id="rejectionTotalRolling">0</strong> / 60s
        </div>
      </div>

      <div class="table-container">
        <table id="rejectionTable">
          <thead>
            <tr>
              <th>Rejection Category</th>
              <th>Session Count</th>
              <th>% of Rejections</th>
              <th>Rolling 60s Activity</th>
              <th>Pipeline Action / Diagnostic</th>
            </tr>
          </thead>
          <tbody id="rejectionTbody">
            <tr>
              <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">
                No candidate rejections recorded yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Controls Row: Profit Hurdle & Scout (Sections 8 & 9) -->
    <div class="two-col-grid">
      <!-- Section 8: Profit Target Control -->
      <section class="card">
        <div class="card-header">
          <div class="card-title">PROFIT TARGET CONTROL</div>
          <div class="card-subtitle">Adjust minimum conservative net profit floor ($0.10 - $0.70 USDC)</div>
        </div>

        <div style="text-align: center; margin: 10px 0;">
          <div style="font-size: 32px; font-weight: 800; color: var(--text-bright); font-family: var(--font-mono);" id="currentDisplay">$${currentUSDC} USDC</div>
          <div class="badge-qual" id="confirmedBadge" style="display: inline-block; margin-top: 4px;">Confirmed Active: $${currentUSDC} USDC</div>
        </div>

        <div class="slider-box">
          <input 
            type="range" 
            id="thresholdSlider" 
            min="0.10" 
            max="0.70" 
            step="0.05" 
            value="${currentUSDC}" 
            aria-label="Minimum Conservative Net Profit"
          >
          <div class="ticks">
            <span>$0.10 (Default)</span>
            <span>$0.20</span>
            <span>$0.30</span>
            <span>$0.40</span>
            <span>$0.50</span>
            <span>$0.60</span>
            <span>$0.70</span>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; margin-top: 10px; font-size: 11px; color: var(--text-muted);">
          <div>Safety Buffer: <strong style="color:var(--text-bright); font-family:var(--font-mono);">$0.25 USDC</strong></div>
          <div>Virtual Capital: <strong style="color:var(--text-bright); font-family:var(--font-mono);">$1,000.00 USDC</strong></div>
        </div>

        <div id="alertBox" class="alert"></div>
      </section>

      <!-- Section 9: Scout Control -->
      <section class="card" id="scoutCard">
        <div class="card-header">
          <div class="card-title">SCOUT CONTROL & EXPANSION</div>
          <button id="btnTriggerScout" class="btn-scout" type="button">Trigger Scout Discovery</button>
        </div>
        <div class="card-subtitle" style="margin-bottom: 12px;">
          On-demand or scheduled pool discovery. Hot-activates new 2-leg routes without scanner restart.
        </div>

        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-box-label">Scout Status</div>
            <div class="stat-box-val"><span id="scoutStatusBadge" class="status-badge status-standby">IDLE</span></div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Last Discovery</div>
            <div class="stat-box-val" id="scoutLastRun" style="font-size: 12px;">NEVER</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Next Scheduled</div>
            <div class="stat-box-val" id="scoutNextRun" style="font-size: 12px;">STANDBY</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Last Verified Pools</div>
            <div class="stat-box-val" id="scoutVerifiedLast">0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Last Routes Generated</div>
            <div class="stat-box-val" id="scoutRoutesLast">0</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">Last Duration</div>
            <div class="stat-box-val" id="scoutDuration">0 ms</div>
          </div>
        </div>

        <div style="margin-top: 10px; font-size: 11px; color: var(--text-muted);">
          Last Error: <span id="scoutLastError" style="color: var(--text-muted); font-family: var(--font-mono);">NONE</span>
        </div>

        <div id="scoutAlert" class="alert"></div>
      </section>
    </div>

    <!-- Section 10: Health & Failure Monitoring -->
    <section class="card">
      <div class="card-header">
        <div class="card-title">HEALTH & FAILURE MONITORING (DIAGNOSTICS)</div>
        <div class="card-subtitle">Connection lifecycle, memory footprint, RPC health, and event loop metrics</div>
      </div>

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-box-label">WS Reconnect Attempts</div>
          <div class="stat-box-val" id="diagWsReconnects">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">WS Message Age</div>
          <div class="stat-box-val" id="diagWsMessageAge">--</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Last Successful Reconnect</div>
          <div class="stat-box-val" id="diagWsLastReconnect" style="font-size: 12px;">NONE</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">RPC Failures</div>
          <div class="stat-box-val" id="diagRpcFailures">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Persistence Errors</div>
          <div class="stat-box-val" id="diagPersistenceErrors">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Event Loop Delay</div>
          <div class="stat-box-val" id="diagEventLoopDelay">0 ms</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Process Memory (RSS / Heap)</div>
          <div class="stat-box-val" id="diagMemory">0 / 0 MB</div>
        </div>
        <div class="stat-box">
          <div class="stat-box-label">Process Uptime</div>
          <div class="stat-box-val" id="diagProcessUptime">00:00:00</div>
        </div>
      </div>

      <div style="margin-top: 10px; font-size: 11px; color: var(--text-muted);">
        Last Persistence Error: <span id="diagLastPersistenceError" style="font-family: var(--font-mono); color: var(--text-muted);">NONE</span>
      </div>
    </section>

    <footer class="footer">
      SolanaBot HUD V2 &bull; Strictly Read-Only Shadow Simulation &bull; Bound to 127.0.0.1 &bull; Zero Private Keys &bull; No Capital at Risk
    </footer>
  </main>

  <script>
    (function() {
      // DOM Elements
      const slider = document.getElementById('thresholdSlider');
      const display = document.getElementById('currentDisplay');
      const confirmedBadge = document.getElementById('confirmedBadge');
      const alertBox = document.getElementById('alertBox');
      const offlineBanner = document.getElementById('offlineBanner');
      const offlineLastSeen = document.getElementById('offlineLastSeen');

      // Top Status Bar
      const telemetryScanner = document.getElementById('telemetryScannerStatus');
      const rpcBadge = document.getElementById('rpcStatusBadge');
      const telemetryWsBadge = document.getElementById('telemetryWsBadge');
      const telemetryNetwork = document.getElementById('telemetryNetwork');
      const btnReconnectWs = document.getElementById('btnReconnectWs');
      const wsAlert = document.getElementById('wsAlert');
      const telemetrySlot = document.getElementById('telemetrySlot');
      const telemetryUptime = document.getElementById('telemetryUptime');
      const telemetryLastUpdated = document.getElementById('telemetryLastUpdated');

      // Hero Elements
      const statGross = document.getElementById('statGrossPositive');
      const statNet = document.getElementById('statNetPositive');
      const statQual = document.getElementById('statQualifiedShadow');
      const statSurv = document.getElementById('statRevalidatedSurviving');
      const statBest = document.getElementById('statBestConservativeNet');
      const statRate = document.getElementById('statShadowNetRate');
      const statActiveHurdle = document.getElementById('statActiveHurdle');
      const telemetryCapital = document.getElementById('telemetryCapital');
      const telemetrySignals = document.getElementById('telemetrySignals');

      // Profit Watch Table
      const profitWatchTbody = document.getElementById('profitWatchTbody');

      // 24-Hour Study Elements
      const studyStatusBadge = document.getElementById('studyStatusBadge');
      const studyStatusDot = document.getElementById('studyStatusDot');
      const studySessionId = document.getElementById('studySessionId');
      const studyHurdle = document.getElementById('studyHurdle');
      const studyElapsed = document.getElementById('studyElapsed');
      const studyHealthyUptime = document.getElementById('studyHealthyUptime');
      const studyDowntime = document.getElementById('studyDowntime');
      const studyQualifiedWindows = document.getElementById('studyQualifiedWindows');
      const studyRevalRate = document.getElementById('studyRevalRate');
      const studyDurationMedP95 = document.getElementById('studyDurationMedP95');
      const studyDurationMinMax = document.getElementById('studyDurationMinMax');
      const studyBestNet = document.getElementById('studyBestNet');
      const studyLiveCount = document.getElementById('studyLiveCount');
      const studyLiveTbody = document.getElementById('studyLiveTbody');
      const studyClosedCount = document.getElementById('studyClosedCount');
      const studyClosedTbody = document.getElementById('studyClosedTbody');
      const studyHourlyChart = document.getElementById('studyHourlyChart');
      const studyHourlyTable = document.getElementById('studyHourlyTable');
      const studyHourlyTbody = document.getElementById('studyHourlyTbody');
      const studyActiveHoursTbody = document.getElementById('studyActiveHoursTbody');

      // Scanner Performance
      const perfRouteEvalsSec = document.getElementById('perfRouteEvalsSec');
      const perfQuoteCalcsSec = document.getElementById('perfQuoteCalcsSec');
      const perfTotalEvals = document.getElementById('perfTotalEvals');
      const perfQuoteValid = document.getElementById('perfQuoteValid');
      const perfAccountUpdatesSec = document.getElementById('perfAccountUpdatesSec');
      const perfQueueDepthDrops = document.getElementById('perfQueueDepthDrops');
      const perfQueueWaitP95 = document.getElementById('perfQueueWaitP95');
      const perfQuoteCalcP95 = document.getElementById('perfQuoteCalcP95');
      const perfRpcLatencyP95 = document.getElementById('perfRpcLatencyP95');

      // Route & Pool Health
      const healthStoredPools = document.getElementById('healthStoredPools');
      const healthVerifiedPools = document.getElementById('healthVerifiedPools');
      const healthUniqueRoutes = document.getElementById('healthUniqueRoutes');
      const healthReadyUptime = document.getElementById('healthReadyUptime');
      const stateVerified = document.getElementById('stateVerified');
      const stateReady = document.getElementById('stateReady');
      const stateStale = document.getElementById('stateStale');
      const stateBlocked = document.getElementById('stateBlocked');
      const stateUnvalidated = document.getElementById('stateUnvalidated');

      // Historical vs Session
      const histTotalPools = document.getElementById('histTotalPools');
      const histVerifiedPools = document.getElementById('histVerifiedPools');
      const histUnverifiedPools = document.getElementById('histUnverifiedPools');
      const histTotalRoutes = document.getElementById('histTotalRoutes');
      const histLastScout = document.getElementById('histLastScout');
      const sessNewPools = document.getElementById('sessNewPools');
      const sessVerifiedPools = document.getElementById('sessVerifiedPools');
      const sessRejectedCandidates = document.getElementById('sessRejectedCandidates');
      const sessNewRoutes = document.getElementById('sessNewRoutes');
      const sessStartTime = document.getElementById('sessStartTime');
      const sessScoutStatus = document.getElementById('sessScoutStatus');

      // Rejection Analysis
      const rejectionMostCommon = document.getElementById('rejectionMostCommon');
      const rejectionTotalSession = document.getElementById('rejectionTotalSession');
      const rejectionTotalRolling = document.getElementById('rejectionTotalRolling');
      const rejectionTbody = document.getElementById('rejectionTbody');

      // Scout Controls
      const btnTriggerScout = document.getElementById('btnTriggerScout');
      const scoutStatusBadge = document.getElementById('scoutStatusBadge');
      const scoutLastRun = document.getElementById('scoutLastRun');
      const scoutNextRun = document.getElementById('scoutNextRun');
      const scoutVerifiedLast = document.getElementById('scoutVerifiedLast');
      const scoutRoutesLast = document.getElementById('scoutRoutesLast');
      const scoutDuration = document.getElementById('scoutDuration');
      const scoutLastError = document.getElementById('scoutLastError');
      const scoutAlert = document.getElementById('scoutAlert');

      // Diagnostics
      const diagWsReconnects = document.getElementById('diagWsReconnects');
      const diagWsMessageAge = document.getElementById('diagWsMessageAge');
      const diagWsLastReconnect = document.getElementById('diagWsLastReconnect');
      const diagRpcFailures = document.getElementById('diagRpcFailures');
      const diagPersistenceErrors = document.getElementById('diagPersistenceErrors');
      const diagEventLoopDelay = document.getElementById('diagEventLoopDelay');
      const diagMemory = document.getElementById('diagMemory');
      const diagProcessUptime = document.getElementById('diagProcessUptime');
      const diagLastPersistenceError = document.getElementById('diagLastPersistenceError');

      // Internal State
      let activeConfirmed = parseFloat(slider.value);
      let isUpdating = false;
      let isDragging = false;
      let isWsReconnecting = false;
      let expandedRowCandidateId = null;
      let lastSuccessfulData = null;

      function updateBadge(el, status, greenVal, amberVal, redVal) {
        if (!el) return;
        el.textContent = status ? status.replace(/_/g, ' ') : '--';
        if (status === greenVal || status === 'ONLINE' || status === 'RUNNING' || status === 'ACTIVE' || status === 'CONNECTED' || status === 'HEALTHY') {
          el.className = 'status-badge status-online';
        } else if (status === amberVal || status === 'RECONNECTING' || status === 'CONNECTING' || status === 'RESTORING_SUBSCRIPTIONS' || status === 'HYDRATING_POOLS' || status === 'DEGRADED' || status === 'STANDBY') {
          el.className = 'status-badge status-standby';
        } else {
          el.className = 'status-badge status-offline';
        }
      }

      function updateWsBadge(status) {
        updateBadge(telemetryWsBadge, status, 'HEALTHY', 'RECONNECTING', 'DISCONNECTED');
      }

      function showAlert(el, msg, isError) {
        if (!el) return;
        el.textContent = msg;
        el.className = isError ? 'alert alert-error' : 'alert alert-success';
        el.style.display = 'block';
      }

      function hideAlert(el) {
        if (el) el.style.display = 'none';
      }

      function formatNumber(num) {
        if (num === null || num === undefined) return '--';
        return Number(num).toLocaleString();
      }

      function formatUsdc(num, prefix) {
        if (num === null || num === undefined) return '$0.0000';
        const p = prefix && num > 0 ? '+' : '';
        return p + '$' + Number(num).toFixed(4);
      }

      // Render Top 10 Profit Watch Table
      function renderProfitWatchTable(items) {
        if (!profitWatchTbody) return;
        if (!items || items.length === 0) {
          profitWatchTbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 24px;">Waiting for route evaluations... Polling live DEX pool states.</td></tr>';
          return;
        }

        let html = '';
        items.forEach(function(item) {
          const isSelected = item.candidateId === expandedRowCandidateId;
          const badgeClass = item.classification === 'QUALIFIED'
            ? 'badge-qual'
            : (item.classification === 'NEAR_MISS' ? 'badge-near' : 'badge-rej');

          const spreadStr = (item.grossSpreadPercent >= 0 ? '+' : '') + item.grossSpreadPercent.toFixed(2) + '%';
          const expNetStr = formatUsdc(item.expectedNetUSDC, true);
          const consNetStr = formatUsdc(item.conservativeNetUSDC, true);
          const shortfallStr = item.shortfallToTargetUSDC <= 0 ? '<span style="color:var(--green)">MET</span>' : '-$' + item.shortfallToTargetUSDC.toFixed(4);
          const ageSec = (item.quoteAgeMs / 1000).toFixed(1) + 's';

          // Main Row
          html += '<tr class="' + (isSelected ? 'selected' : '') + '" data-candidate-id="' + item.candidateId + '">';
          html += '<td style="font-weight:700; color:var(--text-muted);">' + item.rank + '</td>';
          html += '<td style="font-weight:700; color:var(--blue);">' + item.token + '</td>';
          html += '<td>' + item.buyDex + '</td>';
          html += '<td>' + item.sellDex + '</td>';
          html += '<td>$' + item.tradeSizeUSDC.toFixed(2) + '</td>';
          html += '<td style="color:' + (item.grossSpreadPercent > 0 ? 'var(--green)' : 'var(--text-muted)') + ';">' + spreadStr + '</td>';
          html += '<td>' + expNetStr + '</td>';
          html += '<td style="font-weight:700; color:' + (item.conservativeNetUSDC >= (activeConfirmed || 0.10) ? 'var(--green)' : (item.conservativeNetUSDC > 0 ? 'var(--amber)' : 'var(--red)')) + ';">' + consNetStr + '</td>';
          html += '<td>' + shortfallStr + '</td>';
          html += '<td style="color:var(--text-muted);">' + ageSec + '</td>';
          html += '<td><span class="' + badgeClass + '">' + item.status + '</span></td>';
          html += '</tr>';

          // Expandable Detail Row (11 Inspection Fields)
          const isExpanded = isSelected ? 'expanded' : '';
          html += '<tr id="detail-' + item.candidateId + '" class="detail-row ' + isExpanded + '">';
          html += '<td colspan="11">';
          html += '<div class="detail-content">';
          html += '<div class="detail-item"><div class="detail-label">1. Pool 1 Address (Buy)</div><div class="detail-val">' + (item.leg1PoolId || '--') + '</div></div>';
          html += '<div class="detail-item"><div class="detail-label">2. Pool 2 Address (Sell)</div><div class="detail-val">' + (item.leg2PoolId || '--') + '</div></div>';
          html += '<div class="detail-item"><div class="detail-label">3. Exact Swap Directions</div><div class="detail-val">Leg 1: ' + (item.leg1Direction || 'USDC -> Token') + ' &bull; Leg 2: ' + (item.leg2Direction || 'Token -> USDC') + '</div></div>';
          html += '<div class="detail-item"><div class="detail-label">4. DEX Fees (bps)</div><div class="detail-val">Leg 1: ' + (item.leg1FeeBps || 0) + ' bps &bull; Leg 2: ' + (item.leg2FeeBps || 0) + ' bps</div></div>';
          html += '<div class="detail-item"><div class="detail-label">5. Price Impact Per Pool</div><div class="detail-val">' + (item.priceImpactBps || 0) + ' bps aggregate</div></div>';
          html += '<div class="detail-item"><div class="detail-label">6. Slippage Allowance</div><div class="detail-val">' + (item.slippageBps || 10) + ' bps (0.10%)</div></div>';
          html += '<div class="detail-item"><div class="detail-label">7. Network + Priority + Jito Tip</div><div class="detail-val">$' + item.networkFeeUSDC + ' + $' + item.priorityFeeUSDC + ' + $' + item.jitoTipUSDC + ' = $' + item.totalCostsUSDC + ' USDC</div></div>';
          html += '<div class="detail-item"><div class="detail-label">8. Safety Buffer Applied</div><div class="detail-val">$' + item.safetyBufferUSDC + ' USDC</div></div>';
          html += '<div class="detail-item"><div class="detail-label">9. Conservative Net Formula</div><div class="detail-val">MinOut - Cost - Buffer = ' + formatUsdc(item.conservativeNetUSDC, true) + ' USDC</div></div>';
          html += '<div class="detail-item"><div class="detail-label">10. Slot Gap Between Quotes</div><div class="detail-val">' + (item.slotGap !== undefined ? item.slotGap : 0) + ' slots</div></div>';
          html += '<div class="detail-item"><div class="detail-label">11. Revalidation Result</div><div class="detail-val" style="font-weight:700; color:' + (item.revalidationStatus === 'SURVIVED' ? 'var(--green)' : 'var(--amber)') + '">' + (item.revalidationStatus || 'PENDING') + '</div></div>';
          html += '</div>';
          html += '</td>';
          html += '</tr>';
        });

        profitWatchTbody.innerHTML = html;
      }

      window.toggleRowDetail = function(candidateId) {
        if (expandedRowCandidateId === candidateId) {
          expandedRowCandidateId = null;
        } else {
          expandedRowCandidateId = candidateId;
        }
        if (lastSuccessfulData && lastSuccessfulData.profitWatchTable) {
          renderProfitWatchTable(lastSuccessfulData.profitWatchTable);
        }
      };

      if (profitWatchTbody) {
        profitWatchTbody.addEventListener('click', function(e) {
          const row = e.target.closest('tr[data-candidate-id]');
          if (row) {
            const cid = row.getAttribute('data-candidate-id');
            if (cid) window.toggleRowDetail(cid);
          }
        });
      }

      // Render Rejection Analysis Table
      function renderRejectionAnalysis(rep) {
        if (!rejectionTbody || !rep) return;
        rejectionMostCommon.textContent = rep.mostCommonBlocker || 'NONE';
        rejectionTotalSession.textContent = formatNumber(rep.totalSessionRejections || 0);
        rejectionTotalRolling.textContent = formatNumber(rep.totalRolling60sRejections || 0);

        if (!rep.categories || rep.categories.length === 0) {
          rejectionTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:14px;">No rejections recorded.</td></tr>';
          return;
        }

        const descriptions = {
          EXCESSIVE_PRICE_IMPACT: 'Price impact exceeds conservative liquidity ceiling',
          SLOT_MISMATCH: 'Leg quotes observed across incompatible block slots',
          STALE_QUOTE: 'Pool snapshot exceeded maximum freshness TTL',
          WS_DISCONNECTED: 'WebSocket stream disconnected; evaluation aborted',
          LOW_CONSERVATIVE_NET: 'Net profit fails minimum required hurdle floor',
          INSUFFICIENT_LIQUIDITY: 'Pool reserve depth insufficient for quote size',
          OTHER: 'Miscellaneous calculation or parsing error'
        };

        let html = '';
        rep.categories.forEach(function(cat) {
          const isTop = cat.category === rep.mostCommonBlocker && cat.sessionCount > 0;
          html += '<tr style="' + (isTop ? 'background: rgba(245, 158, 11, 0.08);' : '') + '">';
          html += '<td style="font-weight:700;' + (isTop ? 'color:var(--amber);' : 'color:var(--text-bright);') + '">' + cat.category + (isTop ? ' (Top)' : '') + '</td>';
          html += '<td>' + formatNumber(cat.sessionCount) + '</td>';
          html += '<td>' + cat.sessionPercentage.toFixed(1) + '%</td>';
          html += '<td style="color:var(--blue); font-weight:700;">' + formatNumber(cat.rolling60sCount) + ' / min</td>';
          html += '<td style="color:var(--text-muted); font-size:11px;">' + (descriptions[cat.category] || '') + '</td>';
          html += '</tr>';
        });

        rejectionTbody.innerHTML = html;
      }

      function formatMs(ms) {
        if (ms === null || ms === undefined || ms === 0) return '0ms';
        return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
      }
      function formatDurationMs(ms) {
        const totalSec = Math.floor((ms || 0) / 1000);
        const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
        const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
        const s = (totalSec % 60).toString().padStart(2, '0');
        return h + ':' + m + ':' + s;
      }

      function toQatarTimeStr(epochMs) {
        if (!epochMs) return '--:--:--';
        const d = new Date(epochMs + 3 * 3600 * 1000);
        const hh = d.getUTCHours().toString().padStart(2, '0');
        const mm = d.getUTCMinutes().toString().padStart(2, '0');
        const ss = d.getUTCSeconds().toString().padStart(2, '0');
        const mss = d.getUTCMilliseconds().toString().padStart(3, '0');
        return hh + ':' + mm + ':' + ss + '.' + mss + ' AST';
      }

      function renderStudyTelemetry(study) {
        if (!study) return;
        if (studyStatusBadge) {
          updateBadge(studyStatusBadge, study.status || 'STANDBY', 'RUNNING', 'INTERRUPTED', 'OFFLINE');
          if (studyStatusDot) {
            if (study.status === 'RUNNING') {
              studyStatusDot.style.background = 'var(--green)';
              studyStatusDot.style.boxShadow = '0 0 6px var(--green)';
            } else if (study.status === 'COMPLETED') {
              studyStatusDot.style.background = 'var(--blue)';
              studyStatusDot.style.boxShadow = '0 0 6px var(--blue)';
            } else {
              studyStatusDot.style.background = 'var(--amber)';
              studyStatusDot.style.boxShadow = '0 0 6px var(--amber)';
            }
          }
        }
        if (studySessionId) studySessionId.textContent = study.sessionId || 'STANDBY';

        const elapsedStr = formatDurationMs(study.elapsedMs) + ' / ' + formatDurationMs(study.targetDurationMs || 86400000);
        if (studyElapsed) studyElapsed.textContent = elapsedStr;

        const healthyPct = study.elapsedMs > 0 ? ((study.healthyUptimeMs / study.elapsedMs) * 100).toFixed(1) : '100.0';
        if (studyHealthyUptime) studyHealthyUptime.textContent = formatDurationMs(study.healthyUptimeMs) + ' (' + healthyPct + '%)';

        const drops = study.disconnectCount || 0;
        if (studyHurdle) studyHurdle.textContent = '$' + (study.profitHurdleUSDC !== undefined ? Number(study.profitHurdleUSDC).toFixed(2) : '0.10') + ' USDC';
        if (studyDowntime) studyDowntime.textContent = formatDurationMs(study.feedDowntimeMs) + ' (' + drops + ' drops)';

        if (studyQualifiedWindows) studyQualifiedWindows.textContent = formatNumber(study.totalQualifiedWindows || 0);
        if (studyRevalRate) studyRevalRate.textContent = (study.revalidationSuccessPct !== null && study.revalidationSuccessPct !== undefined) ? study.revalidationSuccessPct.toFixed(1) + '%' : 'N/A';

        if (studyDurationMedP95) studyDurationMedP95.textContent = formatMs(study.medianDurationMs) + ' / ' + formatMs(study.p95DurationMs);
        if (studyDurationMinMax) studyDurationMinMax.textContent = formatMs(study.minDurationMs) + ' / ' + formatMs(study.maxDurationMs);
        if (studyBestNet) studyBestNet.textContent = formatUsdc(study.bestConservativeNetUSDC, true);

        // Render 24-Hour Hourly Chart & Table
        if (studyHourlyChart && study.hourlyBuckets) {
          let chartHtml = '';
          const maxWindows = Math.max(1, ...study.hourlyBuckets.map(function(b) { return b.uniqueWindowsCount || 0; }));
          study.hourlyBuckets.forEach(function(b) {
            let barColor = '#141b29';
            let barHeight = 4;
            if (b.status === 'ACTIVE_OBSERVED') {
              barColor = 'var(--green)';
              barHeight = Math.max(10, Math.round((b.uniqueWindowsCount / maxWindows) * 54));
            } else if (b.status === 'NO_OPPORTUNITIES_VERIFIED') {
              barColor = '#2d3b55';
              barHeight = 6;
            } else if (b.status === 'COVERAGE_DEGRADED') {
              barColor = 'var(--amber)';
              barHeight = Math.max(8, Math.round((b.uniqueWindowsCount / maxWindows) * 54));
            } else if (b.status === 'FEED_DISCONNECTED') {
              barColor = 'var(--red)';
              barHeight = 8;
            } else { // FUTURE
              barColor = '#141b29';
              barHeight = 4;
            }
            const covTip = (b.healthyCoveragePct !== null && b.healthyCoveragePct !== undefined) ? b.healthyCoveragePct.toFixed(1) + '%' : 'Pending';
            const tip = b.hourLabel + ' (' + b.timeRangeQatar + ') | Windows: ' + b.uniqueWindowsCount + ' | Best Net: $' + b.bestConservativeNetUSDC.toFixed(4) + ' | Coverage: ' + covTip + ' | Status: ' + b.status;
            chartHtml += '<div style="flex:1; display:flex; flex-direction:column; align-items:center; height:100%; justify-content:flex-end;" title="' + tip + '">';
            chartHtml += '<div style="width:100%; max-width:24px; height:' + barHeight + 'px; background:' + barColor + '; border-radius:2px 2px 0 0; transition:height 0.3s;"></div>';
            chartHtml += '</div>';
          });
          studyHourlyChart.innerHTML = chartHtml;
        }

        if (studyHourlyTbody && study.hourlyBuckets) {
          if (study.hourlyBuckets.length === 0) {
            studyHourlyTbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 14px;">No hourly data available.</td></tr>';
          } else {
            let tHtml = '';
            study.hourlyBuckets.forEach(function(b) {
              let statusBadge = '';
              if (b.status === 'ACTIVE_OBSERVED') {
                statusBadge = '<span class="badge-qual">ACTIVE OBSERVED</span>';
              } else if (b.status === 'NO_OPPORTUNITIES_VERIFIED') {
                statusBadge = '<span style="color:var(--text-muted); font-size:10px;">ZERO VERIFIED</span>';
              } else if (b.status === 'COVERAGE_DEGRADED') {
                statusBadge = '<span class="badge-near">COVERAGE DEGRADED</span>';
              } else if (b.status === 'FEED_DISCONNECTED') {
                statusBadge = '<span class="badge-rej">FEED DISCONNECTED</span>';
              } else {
                statusBadge = '<span style="color:var(--border-bright); font-size:10px;">SCHEDULED</span>';
              }

              const bestNetStr = b.uniqueWindowsCount > 0 ? formatUsdc(b.bestConservativeNetUSDC, true) : '$0.0000';
              const medDurStr = b.uniqueWindowsCount > 0 ? formatMs(b.medianObservedDurationMs) : '--';
              const covColor = b.healthyCoveragePct !== null
                ? (b.healthyCoveragePct >= 95 ? 'var(--green)' : (b.healthyCoveragePct >= 50 ? 'var(--amber)' : 'var(--red)'))
                : 'var(--text-muted)';
              const covText = (b.healthyCoveragePct !== null && b.healthyCoveragePct !== undefined) ? b.healthyCoveragePct.toFixed(1) + '%' : 'Pending';
              const revalText = (b.revalidationSuccessPct !== null && b.revalidationSuccessPct !== undefined) ? b.revalidationSuccessPct.toFixed(1) + '%' : 'N/A';

              tHtml += '<tr>';
              tHtml += '<td style="font-weight:700; color:var(--text-bright); font-family:var(--font-mono);">' + b.hourLabel + '</td>';
              tHtml += '<td style="color:var(--text-muted); font-family:var(--font-mono);">' + b.timeRangeQatar + '</td>';
              tHtml += '<td style="font-weight:700; color:' + (b.uniqueWindowsCount > 0 ? 'var(--green)' : 'var(--text-muted)') + ';">' + b.uniqueWindowsCount + '</td>';
              tHtml += '<td style="color:' + (b.bestConservativeNetUSDC > 0 ? 'var(--green)' : 'var(--text-muted)') + ';">' + bestNetStr + '</td>';
              tHtml += '<td style="font-family:var(--font-mono);">' + medDurStr + '</td>';
              tHtml += '<td>' + revalText + '</td>';
              tHtml += '<td style="font-weight:700; color:' + covColor + ';">' + covText + '</td>';
              tHtml += '<td>' + statusBadge + '</td>';
              tHtml += '</tr>';
            });
            studyHourlyTbody.innerHTML = tHtml;
          }
        }

        // Render Most Active Hours Table
        if (studyActiveHoursTbody) {
          if (!study.mostActiveHours || study.mostActiveHours.length === 0) {
            studyActiveHoursTbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 14px;">No active profitable hours confirmed yet. Unmonitored / disconnected periods are excluded from zero-opportunity conclusions.</td></tr>';
          } else {
            let aHtml = '';
            study.mostActiveHours.forEach(function(a) {
              const aCovText = (a.healthyCoveragePct !== null && a.healthyCoveragePct !== undefined) ? a.healthyCoveragePct.toFixed(1) + '%' : 'N/A';
              aHtml += '<tr>';
              aHtml += '<td style="font-weight:800; color:var(--amber);">#' + a.rank + '</td>';
              aHtml += '<td style="font-weight:700; color:var(--text-bright); font-family:var(--font-mono);">' + a.hourLabel + '</td>';
              aHtml += '<td style="color:var(--blue); font-family:var(--font-mono);">' + a.timeRangeQatar + '</td>';
              aHtml += '<td style="font-weight:700; color:var(--green);">' + a.uniqueWindowsCount + '</td>';
              aHtml += '<td style="font-weight:700; color:var(--green);">' + formatUsdc(a.bestConservativeNetUSDC, true) + '</td>';
              aHtml += '<td style="font-family:var(--font-mono);">' + formatMs(a.medianObservedDurationMs) + '</td>';
              aHtml += '<td style="color:var(--green); font-weight:700;">' + aCovText + '</td>';
              aHtml += '<td><span class="badge-qual">VERIFIED ACTIVE</span></td>';
              aHtml += '</tr>';
            });
            studyActiveHoursTbody.innerHTML = aHtml;
          }
        }

        // Render Live Windows Table
        if (studyLiveCount) studyLiveCount.textContent = study.liveWindows ? study.liveWindows.length : 0;
        if (studyLiveTbody) {
          if (!study.liveWindows || study.liveWindows.length === 0) {
            studyLiveTbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 14px;">No currently open profitable opportunity windows.</td></tr>';
          } else {
            let html = '';
            study.liveWindows.forEach(function(w) {
              const routeStr = w.buyDex + ' -> ' + w.sellDex;
              const liveDur = formatMs(Date.now() - w.firstObservedAt);
              html += '<tr>';
              html += '<td style="font-weight:700; color:var(--blue);">' + w.tokenSymbol + '</td>';
              html += '<td>' + routeStr + '</td>';
              html += '<td>$' + w.tradeSizeUSDC.toFixed(2) + '</td>';
              html += '<td>' + formatUsdc(w.netProfitOpeningUSDC, true) + '</td>';
              html += '<td style="font-weight:700; color:var(--green);">' + formatUsdc(w.netProfitPeakUSDC, true) + '</td>';
              html += '<td style="color:var(--text-bright); font-family:var(--font-mono);">' + liveDur + '</td>';
              html += '<td>' + w.observationCount + '</td>';
              html += '<td style="font-weight:700; color:' + (w.revalidationStatus === 'SURVIVED' ? 'var(--green)' : 'var(--amber)') + '">' + w.revalidationStatus + '</td>';
              html += '<td><span class="badge-qual">OPEN</span></td>';
              html += '</tr>';
            });
            studyLiveTbody.innerHTML = html;
          }
        }

        // Render Closed Windows Table
        if (studyClosedCount) studyClosedCount.textContent = study.closedWindows ? study.closedWindows.length : 0;
        if (studyClosedTbody) {
          if (!study.closedWindows || study.closedWindows.length === 0) {
            studyClosedTbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 14px;">No closed opportunity windows recorded yet.</td></tr>';
          } else {
            let html = '';
            study.closedWindows.forEach(function(w) {
              const routeStr = w.buyDex + ' -> ' + w.sellDex;
              const obsDur = formatMs(w.observedDurationMs !== undefined ? w.observedDurationMs : w.durationLowerBoundMs);
              const clsInt = w.closureIntervalMs !== undefined ? formatMs(w.closureIntervalMs) : '--';
              const firstSeenTime = toQatarTimeStr(w.firstObservedAt);
              const closedTime = w.closedAt ? toQatarTimeStr(w.closedAt) : '--:--:--';

              html += '<tr>';
              html += '<td style="font-weight:700; color:var(--blue);">' + w.tokenSymbol + '</td>';
              html += '<td>' + routeStr + '</td>';
              html += '<td>$' + w.tradeSizeUSDC.toFixed(2) + '</td>';
              html += '<td style="color:var(--green); font-weight:700;">' + formatUsdc(w.netProfitPeakUSDC, true) + '</td>';
              html += '<td style="font-family:var(--font-mono); color:var(--text-bright);">' + obsDur + '</td>';
              html += '<td style="font-family:var(--font-mono); color:var(--text-muted);">' + clsInt + '</td>';
              html += '<td style="color:var(--text-muted); font-family:var(--font-mono); font-size:11px;">' + firstSeenTime + '</td>';
              html += '<td style="color:var(--text-muted); font-family:var(--font-mono); font-size:11px;">' + closedTime + '</td>';
              html += '<td style="color:var(--amber);">' + w.closureReason + '</td>';
              html += '</tr>';
            });
            studyClosedTbody.innerHTML = html;
          }
        }
      }

      async function fetchTelemetry() {
        try {
          const res = await fetch('/api/status');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          lastSuccessfulData = data;

          // Offline banner hide & controls restore
          if (offlineBanner) offlineBanner.style.display = 'none';
          if (slider && !isUpdating) slider.disabled = false;
          if (btnReconnectWs && !isWsReconnecting) btnReconnectWs.disabled = false;
          if (btnTriggerScout) btnTriggerScout.disabled = false;

          // 1. Top Status Bar
          const scState = data.scannerState || (data.scannerOnline ? 'RUNNING' : (data.scannerStatus === 'ONLINE' ? 'RUNNING' : data.scannerStatus));
          updateBadge(telemetryScanner, scState, 'RUNNING', 'DEGRADED', 'OFFLINE');

          const rpcState = data.rpcStatus || 'STANDBY';
          updateBadge(rpcBadge, rpcState, 'ACTIVE', 'DEGRADED', 'OFFLINE');

          const wsState = data.wsStatus || (data.wsConnected ? 'HEALTHY' : 'STANDBY');
          telemetryNetwork.textContent = rpcState + ' / ' + (wsState ? wsState.replace(/_/g, ' ') : 'STANDBY');
          if (!isWsReconnecting) {
            updateWsBadge(wsState);
          }

          telemetrySlot.textContent = data.solanaSlot ? formatNumber(data.solanaSlot) : 'STANDBY';
          telemetryUptime.textContent = data.sessionUptimeFormatted || '00:00:00';
          const nowStr = new Date().toLocaleTimeString();
          telemetryLastUpdated.textContent = nowStr;

          // 2. Hero Profit Monitor
          const pm = data.profitMonitor || {};
          statGross.textContent = formatNumber(pm.grossPositiveOpportunities || data.qualifiedCount || 0);
          statNet.textContent = formatNumber(pm.netPositiveOpportunities || 0);
          statQual.textContent = formatNumber(pm.qualifiedShadowSignals || data.activeShadowSignalsCount || 0);
          statSurv.textContent = formatNumber(pm.revalidatedSurvivingSignals || 0);
          statBest.textContent = formatUsdc(pm.bestConservativeNetUSDC, true);
          statRate.textContent = formatUsdc(pm.shadowNetUSDCPerMinute, true) + ' /m';

          statActiveHurdle.textContent = data.formattedThreshold || ('$' + Number(data.thresholdUSDC).toFixed(2) + ' USDC');
          telemetryCapital.textContent = '$' + (Number(data.activeAllocatedCapitalUSDC) || 0).toFixed(2) + ' USDC';
          telemetrySignals.textContent = String(data.activeShadowSignalsCount || pm.qualifiedShadowSignals || 0);

          // 3. Top 10 Profit Watch Table
          renderProfitWatchTable(data.profitWatchTable || []);

          // 3.5. 24-Hour Profitability Study
          renderStudyTelemetry(data.study);

          // 4. Scanner Performance
          const perf = data.performance || {};
          perfRouteEvalsSec.textContent = formatNumber(perf.routeEvaluationsPerSec || 0) + ' /s';
          perfQuoteCalcsSec.textContent = formatNumber(perf.quoteCalculationsPerSec || 0) + ' /s';
          perfTotalEvals.textContent = formatNumber(perf.totalEvaluationsSession || 0);
          perfQuoteValid.textContent = formatNumber(perf.quoteValidEvaluations || 0) + ' (' + (perf.quoteValidPercentage || 0).toFixed(1) + '%)';
          perfAccountUpdatesSec.textContent = formatNumber(perf.accountUpdatesPerSec || 0) + ' /s';
          perfQueueDepthDrops.textContent = (perf.eventQueueDepth || 0) + ' / ' + (perf.eventQueueDrops || 0);
          perfQueueWaitP95.textContent = (perf.queueWaitP95Us || 0).toFixed(1) + ' µs';
          perfQuoteCalcP95.textContent = (perf.quoteCalculationP95Us || 0).toFixed(1) + ' µs';
          perfRpcLatencyP95.textContent = (perf.rpcLatencyP95Ms && perf.rpcLatencyP95Ms > 0) ? perf.rpcLatencyP95Ms.toFixed(1) + ' ms' : 'N/A';

          // 5. Route & Pool Health
          const rh = data.routeHealth || {};
          healthStoredPools.textContent = formatNumber(rh.totalStoredUniquePools || 0);
          healthVerifiedPools.textContent = formatNumber(rh.verifiedDirectPools || 0);
          healthUniqueRoutes.textContent = formatNumber(rh.totalUnique2LegRoutes || 0);
          healthReadyUptime.textContent = (rh.readyRouteUptimePercent || 0).toFixed(1) + '%';
          stateVerified.textContent = formatNumber(rh.verifiedRoutes || 0);
          stateReady.textContent = formatNumber(rh.readyRoutes || 0);
          stateStale.textContent = formatNumber(rh.staleRoutes || 0);
          stateBlocked.textContent = formatNumber(rh.blockedRoutes || 0);
          stateUnvalidated.textContent = formatNumber(rh.unvalidatedRoutes || 0);

          // 6. Historical vs Session
          const hvs = data.historicalVsSession || {};
          const hist = hvs.historical || {};
          const sess = hvs.session || {};
          histTotalPools.textContent = hist.totalStoredPools !== undefined ? String(hist.totalStoredPools) : '--';
          histVerifiedPools.textContent = hist.verifiedStoredPools !== undefined ? String(hist.verifiedStoredPools) : '--';
          histUnverifiedPools.textContent = hist.unverifiedStoredPools !== undefined ? String(hist.unverifiedStoredPools) : '--';
          histTotalRoutes.textContent = hist.totalStoredRoutes !== undefined ? String(hist.totalStoredRoutes) : '--';
          histLastScout.textContent = hist.lastCompletedScoutRun || 'N/A';

          sessNewPools.textContent = formatNumber(sess.newUniquePoolsDiscovered || 0);
          sessVerifiedPools.textContent = formatNumber(sess.newVerifiedPools || 0);
          sessRejectedCandidates.textContent = formatNumber(sess.rejectedPoolCandidates || 0);
          sessNewRoutes.textContent = formatNumber(sess.newUniqueRoutesGenerated || 0);
          sessStartTime.textContent = sess.sessionStartTime ? new Date(sess.sessionStartTime).toLocaleTimeString() : '--:--:--';
          sessScoutStatus.textContent = (sess.scoutStatus || 'IDLE') + ' (' + (sess.scoutLatestResult || 'None') + ')';

          // 7. Rejection Analysis
          renderRejectionAnalysis(data.rejectionAnalysis);

          // 8. Profit Target Slider
          if (!isUpdating && !isDragging && typeof data.thresholdUSDC === 'number') {
            activeConfirmed = data.thresholdUSDC;
            slider.value = activeConfirmed.toFixed(2);
            display.textContent = '$' + activeConfirmed.toFixed(2) + ' USDC';
            confirmedBadge.textContent = 'Confirmed Active: $' + activeConfirmed.toFixed(2) + ' USDC';
          }

          // 9. Scout Control
          const sc = data.scout;
          if (sc) {
            updateBadge(scoutStatusBadge, sc.scoutStatus || 'IDLE', 'IDLE', 'RUNNING', 'ERROR');
            scoutLastRun.textContent = sc.lastScoutRunTimestamp ? new Date(sc.lastScoutRunTimestamp).toLocaleTimeString() : 'NEVER';
            scoutNextRun.textContent = sc.nextScheduledScoutRun ? new Date(sc.nextScheduledScoutRun).toLocaleTimeString() : 'STANDBY';
            scoutVerifiedLast.textContent = formatNumber(sc.totalVerifiedPools || 0);
            scoutRoutesLast.textContent = formatNumber(sc.totalRoutesInLibrary || 0);
            scoutDuration.textContent = (sc.routeGenerationTimeMs || 0) + ' ms';
            scoutLastError.textContent = sc.lastScoutError || 'NONE';
          }

          // 10. Diagnostics
          const diag = data.diagnostics || {};
          diagWsReconnects.textContent = formatNumber(diag.wsReconnectAttempts || 0);
          diagWsMessageAge.textContent = diag.lastMessageAgeMs !== null && diag.lastMessageAgeMs !== undefined ? (diag.lastMessageAgeMs / 1000).toFixed(1) + 's' : '--';
          diagWsLastReconnect.textContent = diag.lastSuccessfulReconnectTime ? new Date(diag.lastSuccessfulReconnectTime).toLocaleTimeString() : 'NONE';
          diagRpcFailures.textContent = formatNumber(diag.rpcFailures || 0);
          diagPersistenceErrors.textContent = formatNumber(diag.persistenceErrors || 0);
          diagEventLoopDelay.textContent = (diag.eventLoopDelayMs || 0) + ' ms';
          const mem = diag.processMemory || {};
          diagMemory.textContent = (mem.rssMb || 0) + ' / ' + (mem.heapUsedMb || 0) + ' MB';
          diagProcessUptime.textContent = data.sessionUptimeFormatted || '00:00:00';
          diagLastPersistenceError.textContent = diag.lastPersistenceError ? diag.lastPersistenceError.error : 'NONE';

        } catch (err) {
          // Backend offline handling (Section 10)
          if (offlineBanner) {
            offlineBanner.style.display = 'block';
            offlineLastSeen.textContent = new Date().toLocaleTimeString();
          }
          if (telemetryScanner) {
            telemetryScanner.textContent = 'OFFLINE';
            telemetryScanner.className = 'status-badge status-offline';
          }
          if (telemetryNetwork) {
            telemetryNetwork.textContent = 'UNREACHABLE';
          }
          if (!isWsReconnecting && telemetryWsBadge) {
            updateWsBadge('DISCONNECTED');
          }
          if (slider) slider.disabled = true;
          if (btnReconnectWs) btnReconnectWs.disabled = true;
          if (btnTriggerScout) btnTriggerScout.disabled = true;
        }
      }

      // Initial telemetry fetch and poll every 3 seconds
      fetchTelemetry();
      setInterval(fetchTelemetry, 3000);

      // Slider Event Handlers
      slider.addEventListener('mousedown', function() { isDragging = true; });
      slider.addEventListener('touchstart', function() { isDragging = true; });

      slider.addEventListener('input', function(e) {
        const val = parseFloat(e.target.value).toFixed(2);
        display.textContent = '$' + val + ' USDC';
      });

      slider.addEventListener('change', async function(e) {
        isDragging = false;
        if (isUpdating) return;
        const targetValue = parseFloat(e.target.value);
        isUpdating = true;
        slider.disabled = true;

        try {
          const res = await fetch('/api/threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ thresholdUSDC: targetValue })
          });

          const data = await res.json();

          if (res.ok && data.success) {
            activeConfirmed = data.thresholdUSDC;
            const formatted = '$' + activeConfirmed.toFixed(2) + ' USDC';
            display.textContent = formatted;
            slider.value = activeConfirmed.toFixed(2);
            confirmedBadge.textContent = 'Confirmed Active: ' + formatted;
            showAlert(alertBox, 'Active profit threshold updated to ' + formatted + ' (applied immediately without scanner restart).', false);
          } else {
            slider.value = activeConfirmed.toFixed(2);
            display.textContent = '$' + activeConfirmed.toFixed(2) + ' USDC';
            showAlert(alertBox, 'Update rejected: ' + (data.error || 'Invalid setting'), true);
          }
        } catch (err) {
          slider.value = activeConfirmed.toFixed(2);
          display.textContent = '$' + activeConfirmed.toFixed(2) + ' USDC';
          showAlert(alertBox, 'Communication error: ' + (err.message || 'Could not reach local server'), true);
        } finally {
          slider.disabled = false;
          isUpdating = false;
        }
      });

      // Scout Trigger Button
      if (btnTriggerScout) {
        btnTriggerScout.addEventListener('click', async function() {
          btnTriggerScout.disabled = true;
          btnTriggerScout.textContent = 'Discovering...';
          hideAlert(scoutAlert);

          try {
            const res = await fetch('/api/scout/trigger', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
              const r = data.result;
              showAlert(scoutAlert, 'Scout cycle completed: ' + r.candidatesFound + ' found, ' +
                r.candidatesVerified + ' verified, ' + r.routesGenerated + ' new routes generated (' + r.durationMs + 'ms).', false);
              fetchTelemetry();
            } else {
              showAlert(scoutAlert, 'Scout trigger failed: ' + (data.error || 'Unknown error'), true);
            }
          } catch (err) {
            showAlert(scoutAlert, 'Error contacting Scout endpoint: ' + (err.message || String(err)), true);
          } finally {
            btnTriggerScout.disabled = false;
            btnTriggerScout.textContent = 'Trigger Scout Discovery';
          }
        });
      }

      // Reconnect WebSocket Button
      if (btnReconnectWs) {
        btnReconnectWs.addEventListener('click', async function() {
          if (isWsReconnecting) return;
          isWsReconnecting = true;
          btnReconnectWs.disabled = true;
          btnReconnectWs.textContent = 'RECONNECTING...';
          updateWsBadge('RECONNECTING');
          hideAlert(wsAlert);

          try {
            const res = await fetch('/api/ws/reconnect', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
              updateWsBadge('CONNECTED');
              const duration = data.durationMs ? ' (' + Math.round(data.durationMs) + 'ms)' : '';
              const slotInfo = data.slot ? ' at slot ' + data.slot : '';
              showAlert(wsAlert, 'WebSocket reconnected successfully' + slotInfo + duration + '. Pool snapshots and routes revalidated.', false);
              fetchTelemetry();
            } else {
              updateWsBadge('FAILED');
              showAlert(wsAlert, 'WebSocket reconnection failed: ' + (data.error || 'Server error'), true);
            }
          } catch (err) {
            updateWsBadge('FAILED');
            showAlert(wsAlert, 'Error contacting WebSocket reconnect endpoint: ' + (err.message || String(err)), true);
          } finally {
            btnReconnectWs.disabled = false;
            btnReconnectWs.textContent = 'RECONNECT WEBSOCKET';
            isWsReconnecting = false;
          }
        });
      }
    })();
  </script>
</body>
</html>`;
  }
}
