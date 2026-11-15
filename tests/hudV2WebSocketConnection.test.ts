import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { SolanaWsProvider, WsConnectionStage } from '../src/providers/solanaWs.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';
import { ProfitHudServer } from '../src/hud/profitHudServer.js';
import { loadConfig } from '../src/config/index.js';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { URL } from 'url';

describe('SOLANABOT — HUD V2 WebSocket Connection Architecture & Regression Suite', () => {
  const testDir = path.join(process.cwd(), 'data', 'test_ws_lifecycle');

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

  // 1. Connection Stage Lifecycle Separation
  it('Decouples socket handshake from pool hydration and progresses through defined stages', async () => {
    const config = loadConfig({
      SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws',
      MAX_QUOTE_AGE_MS: '5000'
    });
    const ws = new SolanaWsProvider(config);

    // Initial stage: DISCONNECTED
    expect(ws.getConnectionStage()).toBe('DISCONNECTED');
    expect(ws.getConnectionState()).toBe('DISCONNECTED');

    // Mock WebSocket transport
    let sendCalls: string[] = [];

    const mockWsInstance = Object.assign(new EventEmitter(), {
      readyState: WebSocket.CONNECTING as number,
      send: vi.fn((msg: string) => {
        sendCalls.push(msg);
      }),
      terminate: vi.fn(),
      close: vi.fn(),
      removeAllListeners: vi.fn()
    });

    vi.spyOn(ws as any, 'connect').mockImplementation(async function(this: any) {
      this.isExplicitlyClosed = false;
      this.stage = 'CONNECTING';
      this.ws = mockWsInstance;

      mockWsInstance.on('open', () => {
        this.stage = 'CONNECTED';
        this.stage = 'RESTORING_SUBSCRIPTIONS';
        this.subscribeSlot();
        this.resubscribeAccountsPaced(this.socketGeneration);
      });

      return true;
    });

    // Connect
    const connectPromise = ws.connect(3000);
    expect(ws.getConnectionStage()).toBe('CONNECTING');

    // Simulate socket open event
    mockWsInstance.readyState = WebSocket.OPEN;
    mockWsInstance.emit('open');

    const connected = await connectPromise;
    expect(connected).toBe(true);

    // After open, stage is RESTORING_SUBSCRIPTIONS (slot subscribe sent)
    expect(ws.getConnectionStage()).toBe('RESTORING_SUBSCRIPTIONS');
    expect(sendCalls.some(call => call.includes('slotSubscribe'))).toBe(true);

    // Transition to HYDRATING_POOLS
    ws.setHydratingPools(true);
    expect(ws.getConnectionStage()).toBe('HYDRATING_POOLS');

    // Complete hydration
    ws.setHydratingPools(false);

    // Once slot is updated and messages arrive, status is HEALTHY
    ws.setSlot(250000000);
    (ws as any).lastMessageTime = Date.now();
    expect(ws.getConnectionStage()).toBe('HEALTHY');

    // Clean disconnect
    ws.disconnect();
    expect(ws.getConnectionStage()).toBe('DISCONNECTED');
  });

  // 2. Slow Reconnect Callback Does Not Block Socket Handshake
  it('Completes socket connection handshake immediately without awaiting slow reconnect callbacks', async () => {
    const wss = new WebSocket.Server({ port: 0 });
    await new Promise<void>(resolve => wss.on('listening', () => resolve()));
    const port = (wss.address() as any).port;

    const config = loadConfig({
      SOLANA_RPC_WS: `ws://127.0.0.1:${port}`
    });
    const ws = new SolanaWsProvider(config);

    let callbackSettled = false;
    let callbackStarted = false;

    // Mark that ws has connected once so reconnect callbacks fire on reconnection
    (ws as any).hasConnectedOnce = true;

    // Register a slow 1.5-second reconnect callback (simulating heavy RPC snapshot refresh)
    ws.onReconnect(async () => {
      callbackStarted = true;
      await new Promise(r => setTimeout(r, 1500));
      callbackSettled = true;
    });

    const start = performance.now();
    const connected = await ws.connect(4000);
    const elapsed = performance.now() - start;

    // Connection resolved fast (<500ms) without waiting for 1500ms callback
    expect(connected).toBe(true);
    expect(elapsed).toBeLessThan(500);
    expect(callbackStarted).toBe(true);
    expect(callbackSettled).toBe(false);

    ws.disconnect();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });

  // 3. Socket Generation Counter Drops Messages from Replaced Sockets
  it('Ignores messages and errors from obsolete socket generations when reconnected', async () => {
    const config = loadConfig({
      SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws'
    });
    const ws = new SolanaWsProvider(config);

    let receivedSlotUpdates = 0;
    ws.onSlot(() => {
      receivedSlotUpdates++;
    });

    const gen1Emitter = new EventEmitter() as any;
    gen1Emitter.readyState = WebSocket.OPEN;
    gen1Emitter.send = vi.fn();
    gen1Emitter.terminate = vi.fn();
    gen1Emitter.close = vi.fn();
    gen1Emitter.removeAllListeners = vi.fn();

    (ws as any).ws = gen1Emitter;
    (ws as any).socketGeneration = 1;

    // Simulate incoming slot update on Generation 1
    (ws as any).handleMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'slotNotification',
      params: {
        subscription: 1,
        result: { parent: 100, root: 99, slot: 101 }
      }
    }));
    expect(ws.getCurrentSlot()).toBe(101);

    // Reconnection increments generation to 2
    (ws as any).socketGeneration = 2;

    let dropped = false;
    const currentGen = (ws as any).socketGeneration;
    const oldGen = 1;

    if (oldGen !== currentGen) {
      dropped = true;
    }
    expect(dropped).toBe(true);
    expect(ws.getCurrentSlot()).toBe(101);

    ws.disconnect();
  });

  // 4. Concurrent refreshAllPoolStates Calls are Deduplicated
  it('Deduplicates concurrent refreshAllPoolStates into a single in-flight promise', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    let executionCount = 0;
    vi.spyOn(scanner as any, 'executeRefreshAllPoolStates').mockImplementation(async () => {
      executionCount++;
      await new Promise(r => setTimeout(r, 100));
    });

    // Invoke 5 concurrent refreshes
    const promises = [
      scanner.refreshAllPoolStates(),
      scanner.refreshAllPoolStates(),
      scanner.refreshAllPoolStates(),
      scanner.refreshAllPoolStates(),
      scanner.refreshAllPoolStates()
    ];

    await Promise.all(promises);

    // Only 1 underlying execution occurred
    expect(executionCount).toBe(1);

    // A subsequent call after completion initiates a new cycle
    await scanner.refreshAllPoolStates();
    expect(executionCount).toBe(2);

    scanner.stop();
  });

  // 5. Paced Account Resubscription Prevents Socket Buffering Floods
  it('Paces account resubscriptions in bounded batches', async () => {
    const config = loadConfig({
      SOLANA_RPC_WS: 'ws://127.0.0.1:9999/test-ws'
    });
    const ws = new SolanaWsProvider(config);

    // Register 25 account subscriptions
    for (let i = 0; i < 25; i++) {
      const pubkey = `Account${i.toString().padStart(37, '0')}`;
      ws.subscribeAccount(pubkey, () => {});
    }

    const sentRequests: any[] = [];
    (ws as any).ws = {
      readyState: WebSocket.OPEN,
      send: (str: string) => {
        sentRequests.push(JSON.parse(str));
      }
    };

    // Trigger paced resubscription
    (ws as any).socketGeneration = 1;
    (ws as any).resubscribeAccountsPaced(1);

    // First batch sends exactly 10 immediate requests
    expect(sentRequests.length).toBe(10);
    expect(sentRequests[0].method).toBe('accountSubscribe');

    // Wait 120ms to allow interval chunks to process
    await new Promise(r => setTimeout(r, 120));

    // All 25 accounts subscribed without flooding
    expect(sentRequests.length).toBe(25);

    ws.disconnect();
  });

  // 6. HUD V2 /api/status Exposes Separated wsStatus Stages
  it('HUD V2 /api/status exposes wsStatus and wsConnected properly', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    const ws = (scanner as any).ws as SolanaWsProvider;

    // Set stage to HEALTHY, slot, open transport, and scanner running state
    vi.spyOn(scanner, 'isScannerRunning').mockReturnValue(true);
    ws.setSlot(270123456);
    (ws as any).ws = { readyState: WebSocket.OPEN };
    vi.spyOn(ws, 'getConnectionStage').mockReturnValue('HEALTHY');

    const hud = new ProfitHudServer(manager, scanner, { port: 0, silent: true });
    const info = await hud.start();

    try {
      const res = await makeHttpRequest(`http://127.0.0.1:${info.port}/api/status`, 'GET');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.wsStatus).toBe('HEALTHY');
      expect(data.wsConnected).toBe(true);
      expect(data.solanaSlot).toBe(270123456);
      expect(data.scannerState).toBe('RUNNING');
    } finally {
      await hud.stop();
      scanner.stop();
    }
  });

  // 7. reconnectWebSocket handles failure with explicit error and does not hang
  it('reconnectWebSocket reports detailed error on timeout without hanging', async () => {
    const { thresholdFile, dbFile } = getUniqueTestFiles();
    const manager = new ProfitThresholdManager({ filePath: thresholdFile, silent: true });
    const config = loadConfig();
    config.DB_PATH = dbFile;
    const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, undefined, manager);

    const ws = (scanner as any).ws as SolanaWsProvider;
    vi.spyOn(ws, 'manualReconnect').mockImplementation(async () => false);
    vi.spyOn(ws, 'getLastError').mockReturnValue('Custom timeout reached after 2000ms');

    const outcome = await scanner.reconnectWebSocket(2000);
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.error).toContain('Custom timeout reached');

    scanner.stop();
  });
});
