import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { SolanaWsProvider, WsConnectionState } from '../src/providers/solanaWs.js';
import { loadConfig } from '../src/config/index.js';

describe('SOLANABOT — Manual WebSocket Reconnect HUD Button Suite', () => {
  const testDir = path.join(process.cwd(), 'data', 'test_hud_ws_reconnect');

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

  // 1. UI Elements & Layout Verification
  it('Requirement 1 & 4: HUD dashboard contains RECONNECT WEBSOCKET button and connection status badge beside RPC / WS', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(`http://127.0.0.1:${info.port}/`, 'GET');
      expect(res.statusCode).toBe(200);
      const html = res.body;

      // 1. Button element with label
      expect(html).toContain('id="btnReconnectWs"');
      expect(html).toContain('RECONNECT WEBSOCKET');
      expect(html).toContain('class="btn-ws"');

      // 2. Status badge beside RPC / WebSocket
      expect(html).toContain('id="telemetryWsBadge"');
      expect(html).toContain('RPC / WebSocket');
      expect(html).toContain('telemetryNetwork');

      // 3. Dark HUD CSS styling
      expect(html).toContain('.btn-ws');
      expect(html).toContain('.btn-ws:hover');
      expect(html).toContain('.btn-ws:disabled');

      // 4. Alert container
      expect(html).toContain('id="wsAlert"');

      // 5. JavaScript click handler & debounce logic
      expect(html).toContain("fetch('/api/ws/reconnect'");
      expect(html).toContain("btnReconnectWs.disabled = true");
      expect(html).toContain("updateWsBadge('RECONNECTING')");
    } finally {
      await hud.stop();
    }
  });

  // 2. Security: Host and Origin Enforcement
  it('Requirement 5: Rejects non-localhost Host / Origin headers on POST /api/ws/reconnect with 403 Forbidden', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const info = await hud.start();

    try {
      // Foreign origin
      const foreignRes = await makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Origin': 'http://malicious-website.com' }
      );
      expect(foreignRes.statusCode).toBe(403);
      const foreignData = JSON.parse(foreignRes.body);
      expect(foreignData.success).toBe(false);
      expect(foreignData.error).toContain('Forbidden');

      // Foreign host header
      const hostRes = await makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Host': 'evil-proxy.org', 'Origin': `http://127.0.0.1:${info.port}` }
      );
      expect(hostRes.statusCode).toBe(403);
    } finally {
      await hud.stop();
    }
  });

  // 3. Scanner Connectivity Check
  it('Requirement 5: Returns 503 when scanner is not attached to HUD server', async () => {
    const { thresholdFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const hud = new ProfitHudServer(manager, undefined, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Origin': `http://127.0.0.1:${info.port}` }
      );
      expect(res.statusCode).toBe(503);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(false);
      expect(data.wsStatus).toBe('STANDBY');
      expect(data.error).toBe('Scanner not connected');
    } finally {
      await hud.stop();
    }
  });

  // 4. Concurrency Guard: Prevents Duplicate Connections on Repeated Clicks
  it('Requirement 2 & 5: Blocks concurrent reconnect requests with 409 Conflict', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    // Mock reconnectWebSocket to simulate an in-flight operation
    let resolveReconnect: (val: any) => void;
    const reconnectPromise = new Promise(resolve => {
      resolveReconnect = resolve;
    });
    vi.spyOn(scanner, 'reconnectWebSocket').mockImplementation(() => reconnectPromise as any);

    const hud = new ProfitHudServer(manager, scanner, { port: 0, silent: true });
    const info = await hud.start();

    try {
      // First request initiates reconnection
      const req1Promise = makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Origin': `http://127.0.0.1:${info.port}` }
      );

      // Give microtask tick to enter isWsReconnecting lock
      await new Promise(r => setTimeout(r, 20));

      // Second concurrent request must be rejected immediately with 409
      const req2Res = await makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Origin': `http://127.0.0.1:${info.port}` }
      );

      expect(req2Res.statusCode).toBe(409);
      const data2 = JSON.parse(req2Res.body);
      expect(data2.success).toBe(false);
      expect(data2.wsStatus).toBe('RECONNECTING');
      expect(data2.error).toContain('already in progress');

      // Complete first request
      resolveReconnect!({
        success: true,
        status: 'CONNECTED',
        slot: 12345,
        durationMs: 45
      });

      const req1Res = await req1Promise;
      expect(req1Res.statusCode).toBe(200);
      const data1 = JSON.parse(req1Res.body);
      expect(data1.success).toBe(true);
      expect(data1.wsStatus).toBe('CONNECTED');
      expect(data1.slot).toBe(12345);
    } finally {
      await hud.stop();
      scanner.stop();
    }
  });

  // 5. Successful Reconnection Lifecycle & Recovery
  it('Requirement 2 & 3: Safely reconnects WebSocket, refreshes pool states, does not trigger Scout or restart scanner', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    // Track calls
    const scoutSpy = vi.spyOn(scanner, 'triggerScoutDiscovery');
    const refreshSpy = vi.spyOn(scanner, 'refreshAllPoolStates').mockImplementation(async () => {});
    const ws = (scanner as any).ws as SolanaWsProvider;
    const wsManualSpy = vi.spyOn(ws, 'manualReconnect').mockImplementation(async () => true);

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
      expect(typeof data.durationMs).toBe('number');

      // Verified: ws.manualReconnect called
      expect(wsManualSpy).toHaveBeenCalledTimes(1);

      // Verified: pool states refreshed
      expect(refreshSpy).toHaveBeenCalled();

      // Verified: Scout was NOT triggered
      expect(scoutSpy).not.toHaveBeenCalled();
    } finally {
      await hud.stop();
      scanner.stop();
    }
  });

  // 6. Failed Reconnection & Error Status
  it('Requirement 4 & 5: When manual reconnect fails, returns 502 with FAILED status and error description', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    const ws = (scanner as any).ws as SolanaWsProvider;
    vi.spyOn(ws, 'manualReconnect').mockImplementation(async () => false);

    const hud = new ProfitHudServer(manager, scanner, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(
        `http://127.0.0.1:${info.port}/api/ws/reconnect`,
        'POST',
        undefined,
        { 'Origin': `http://127.0.0.1:${info.port}` }
      );

      expect(res.statusCode).toBe(502);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(false);
      expect(data.wsStatus).toBe('FAILED');
      expect(data.error).toContain('failed to establish');

      // Status endpoint reflects FAILED or DISCONNECTED, never CONNECTED
      const statusRes = await makeHttpRequest(`http://127.0.0.1:${info.port}/api/status`, 'GET');
      const statusData = JSON.parse(statusRes.body);
      expect(statusData.wsStatus).not.toBe('CONNECTED');
      expect(['FAILED', 'DISCONNECTED']).toContain(statusData.wsStatus);
    } finally {
      await hud.stop();
      scanner.stop();
    }
  });

  // 7. SolanaWsProvider Lifecycle: Subscriptions, Timers, and Backoff
  it('Requirement 2 & 3: SolanaWsProvider cancels pending timers, preserves account registrations, and reconnects', async () => {
    const config = loadConfig({
      SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws'
    });
    const wsProvider = new SolanaWsProvider(config);

    // Register test account subscriptions
    let accountUpdateCalls = 0;
    wsProvider.subscribeAccount('Account1111111111111111111111111111111111111', () => {
      accountUpdateCalls++;
    });
    wsProvider.subscribeAccount('Account2222222222222222222222222222222222222', () => {});

    expect(wsProvider.getStats().subscriptionCount).toBe(2);

    // Spy on connect
    const connectSpy = vi.spyOn(wsProvider, 'connect').mockImplementation(async () => {
      (wsProvider as any).ws = { readyState: 1 } as any; // WebSocket.OPEN
      return true;
    });

    // Invoke manual reconnect
    const outcome = await wsProvider.manualReconnect(5000);
    expect(outcome).toBe(true);
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // Subscriptions preserved
    expect(wsProvider.getStats().subscriptionCount).toBe(2);
    expect(wsProvider.getConnectionState()).toBe('CONNECTED');

    // Clean disconnect
    wsProvider.disconnect();
    expect(wsProvider.getConnectionState()).toBe('DISCONNECTED');
  });

  // 8. Four Defined Status States in Telemetry
  it('Requirement 4: Exposes exactly CONNECTED, RECONNECTING, DISCONNECTED, or FAILED states', () => {
    const config = loadConfig({
      SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws'
    });
    const ws = new SolanaWsProvider(config);

    // 1. Initial disconnected
    expect(ws.getConnectionState()).toBe('DISCONNECTED');

    // 2. Reconnecting state
    (ws as any).isReconnectingInProgress = true;
    expect(ws.getConnectionState()).toBe('RECONNECTING');
    (ws as any).isReconnectingInProgress = false;

    // 3. Failed state
    (ws as any).lastManualAttemptFailed = true;
    expect(ws.getConnectionState()).toBe('FAILED');

    // 4. Connected state overrides failed when socket opens
    (ws as any).ws = { readyState: 1 } as any; // WebSocket.OPEN = 1
    (ws as any).lastManualAttemptFailed = false;
    expect(ws.getConnectionState()).toBe('CONNECTED');

    ws.disconnect();
    expect(ws.getConnectionState()).toBe('DISCONNECTED');
  });

  // 9. Preserves Automatic Reconnection on Drop
  it('Requirement 2: Preserves automatic reconnection timer on unexpected disconnect', async () => {
    const config = loadConfig({
      SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws'
    });
    const ws = new SolanaWsProvider(config);

    let disconnectCallbacksFired = 0;
    ws.onDisconnect(() => {
      disconnectCallbacksFired++;
    });

    // Simulate socket disconnect via internal handler
    (ws as any).handleDisconnect();

    expect(disconnectCallbacksFired).toBe(1);
    // Automatic reconnect timer must be scheduled
    expect((ws as any).reconnectTimer).not.toBeNull();
    expect((ws as any).reconnectAttempts).toBe(1);

    // Clean teardown clears timer
    ws.disconnect();
    expect((ws as any).reconnectTimer).toBeNull();
  });
});
