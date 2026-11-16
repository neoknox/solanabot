import WebSocket from 'ws';
import { FeedHealth } from '../types/index.js';
import { AppConfig } from '../config/index.js';

export type AccountUpdateHandler = (
  accountData: Buffer,
  slot: number,
  receivedAtMs?: number,
  monotonicReceiptTime?: number
) => void;
export type SlotUpdateHandler = (slot: number) => void;

export type WsConnectionStage =
  | 'STANDBY'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RESTORING_SUBSCRIPTIONS'
  | 'HYDRATING_POOLS'
  | 'HEALTHY'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'FAILED';

export type WsConnectionState = 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'FAILED';

export interface WsStats {
  connected: boolean;
  reconnectCount: number;
  sessionTotalDisconnects?: number;
  sessionTotalReconnectAttempts?: number;
  sessionTotalReconnectSuccesses?: number;
  lastDisconnectCode?: number | null;
  lastDisconnectReason?: string | null;
  lastDisconnectTime?: number;
  lastReconnectResult?: 'SUCCESS' | 'FAILED' | 'PENDING' | 'NONE';
  healthyFeedAgeMs?: number;
  lastSlot: number;
  lastMessageTime: number;
  subscriptionCount: number;
  confirmedSubscriptionCount?: number;
  rejectedSubscriptionCount?: number;
  maxSubscriptions?: number;
  activeAccountUpdatesCount?: number;
  slotGapCount?: number;
  totalSlotsSkipped?: number;
  maxSlotGap?: number;
  totalDowntimeMs?: number;
  downtimeEventsCount?: number;
  messagesTotal?: number;
  connectionState?: WsConnectionState;
  connectionStage?: WsConnectionStage;
  isReconnecting?: boolean;
  lastError?: string | null;
}

export class SolanaWsProvider {
  private ws: WebSocket | null = null;
  private config: AppConfig;
  private isExplicitlyClosed = false;
  private isReconnectingInProgress = false;
  private lastManualAttemptFailed = false;
  private activeReconnectPromise: Promise<boolean> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private backoffBaseMs = 1000;
  private backoffMaxMs = 30000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pacingTimer: NodeJS.Timeout | null = null;
  private subscriptionQueue: string[] = [];
  private socketGeneration = 0;
  private stage: WsConnectionStage = 'STANDBY';
  private lastError: string | null = null;

  // Session-wide lifetime diagnostic counters (NEVER reset on reconnect success)
  private sessionStartTime = Date.now();
  private sessionTotalDisconnects = 0;
  private sessionTotalReconnectAttempts = 0;
  private sessionTotalReconnectSuccesses = 0;
  private lastDisconnectCode: number | null = null;
  private lastDisconnectReason: string | null = null;
  private lastDisconnectTime = 0;
  private lastReconnectResult: 'SUCCESS' | 'FAILED' | 'PENDING' | 'NONE' = 'NONE';
  private lastHealthyFeedTime = 0;
  private disconnectedGenerations = new Set<number>();

  private currentSlot = 0;
  private lastMessageTime = 0;
  private subscriptionCounter = 1;
  private accountSubscriptions = new Map<string, { id?: number; handler: AccountUpdateHandler }>();
  private subIdToPubkey = new Map<number, string>();
  private reqIdToPubkey = new Map<number, string>();
  private reqIdForSlot: number | null = null;
  private slotSubId: number | null = null;
  private messagesTotal = 0;

  // Connection reliability & subscription health telemetry
  private hasConnectedOnce = false;
  private slotGapCount = 0;
  private totalSlotsSkipped = 0;
  private maxSlotGap = 0;
  private disconnectStartTime = 0;
  private totalDowntimeMs = 0;
  private downtimeEventsCount = 0;
  private activeAccountsWithUpdates = new Set<string>();

  private onReconnectCallbacks: Array<() => void | Promise<void>> = [];
  private onDisconnectCallbacks: Array<() => void> = [];
  private onSlotCallbacks: Array<SlotUpdateHandler> = [];
  private maxSubscriptions: number;
  private rejectedSubscriptionCount = 0;

  constructor(config: AppConfig) {
    this.config = config;
    this.maxSubscriptions = (config as any).MAX_WS_SUBSCRIPTIONS ?? 25;
  }

  public canSubscribeMore(): boolean {
    return this.maxSubscriptions === 0 || this.accountSubscriptions.size < this.maxSubscriptions;
  }

  public connect(timeoutMs = 8000): Promise<boolean> {
    this.isExplicitlyClosed = false;
    const currentGen = ++this.socketGeneration;
    this.stage = this.isReconnectingInProgress ? 'RECONNECTING' : 'CONNECTING';

    return new Promise((resolve) => {
      let isSettled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (result: boolean) => {
        if (isSettled) return;
        isSettled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(result);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!isSettled) {
            if (this.socketGeneration === currentGen) {
              const timeoutReason = `Connection handshake timeout (${timeoutMs}ms) exceeded`;
              this.lastError = timeoutReason;
              this.lastReconnectResult = 'FAILED';
              try { this.ws?.terminate(); } catch {}
              this.handleDisconnect(currentGen, timeoutReason, undefined, false);
            }
            finish(false);
          }
        }, timeoutMs);
        timer.unref();
      }

      try {
        this.ws = new WebSocket(this.config.SOLANA_RPC_WS);

        this.ws.on('open', () => {
          if (this.socketGeneration !== currentGen) return;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (this.disconnectStartTime > 0) {
            this.totalDowntimeMs += Date.now() - this.disconnectStartTime;
            this.disconnectStartTime = 0;
          }
          this.reconnectAttempts = 0;
          this.lastManualAttemptFailed = false;
          this.lastMessageTime = Date.now();
          this.lastHealthyFeedTime = Date.now();
          this.lastReconnectResult = 'SUCCESS';
          this.lastError = null;
          this.stage = 'CONNECTED';
          if (this.hasConnectedOnce || this.isReconnectingInProgress) {
            this.sessionTotalReconnectSuccesses++;
          }

          // 1. Resolve connect promise immediately once transport is open
          finish(true);

          // 2. Advance to restoring subscriptions
          this.stage = 'RESTORING_SUBSCRIPTIONS';
          this.subscribeSlot();
          this.resubscribeAccountsPaced(currentGen);
          this.startHeartbeat();

          // 3. Trigger reconnect callbacks in background without blocking connect() ONLY on genuine reconnection
          if (this.hasConnectedOnce) {
            for (const cb of this.onReconnectCallbacks) {
              try {
                const res = cb();
                if (res && typeof (res as Promise<any>).then === 'function') {
                  (res as Promise<any>).catch((err) => {
                    console.warn('[SolanaWsProvider] Reconnect callback error:', err?.message || String(err));
                  });
                }
              } catch (err: any) {
                console.warn('[SolanaWsProvider] Reconnect callback error:', err?.message || String(err));
              }
            }
          } else {
            this.hasConnectedOnce = true;
          }
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          if (this.socketGeneration !== currentGen) return;
          this.lastMessageTime = Date.now();
          this.lastHealthyFeedTime = Date.now();
          this.handleMessage(data.toString());
        });

        this.ws.on('pong', () => {
          if (this.socketGeneration !== currentGen) return;
          this.lastMessageTime = Date.now();
          this.lastHealthyFeedTime = Date.now();
        });

        this.ws.on('error', (err) => {
          if (this.socketGeneration !== currentGen) return;
          const errMsg = err instanceof Error ? err.message : String(err);
          this.lastError = errMsg;
          console.warn(`[SolanaWsProvider] WebSocket error: ${errMsg}`);
        });

        this.ws.on('close', (code: number, reasonBuf: Buffer) => {
          if (this.socketGeneration !== currentGen) return;
          const reasonStr = reasonBuf ? reasonBuf.toString('utf8') : '';
          const codeMeaning = this.getCloseCodeMeaning(code);
          const fullReason = `WS Closed [code=${code} (${codeMeaning})]${reasonStr ? ': ' + reasonStr : ''}`;
          this.stage = 'DISCONNECTED';
          this.lastError = fullReason;
          console.warn(`[SolanaWsProvider] ${fullReason}`);
          this.handleDisconnect(currentGen, fullReason, code, false);
          finish(false);
        });
      } catch (err: any) {
        if (this.socketGeneration === currentGen) {
          const errReason = err?.message || String(err);
          this.lastError = errReason;
          this.stage = 'DISCONNECTED';
          this.handleDisconnect(currentGen, errReason, undefined, false);
        }
        finish(false);
      }
    });
  }

  private handleDisconnect(gen: number, reason = 'Connection closed', code?: number, isManual = false): void {
    if (this.disconnectedGenerations.has(gen)) {
      return;
    }
    this.disconnectedGenerations.add(gen);

    this.sessionTotalDisconnects++;
    this.lastDisconnectTime = Date.now();
    this.lastDisconnectCode = code ?? null;
    this.lastDisconnectReason = reason;

    if (this.disconnectStartTime === 0) {
      this.disconnectStartTime = Date.now();
      this.downtimeEventsCount++;
    }

    if (this.pacingTimer) {
      clearInterval(this.pacingTimer);
      this.pacingTimer = null;
    }
    this.subscriptionQueue = [];

    this.slotSubId = null;
    this.subIdToPubkey.clear();
    this.reqIdToPubkey.clear();
    this.reqIdForSlot = null;
    for (const [key, val] of this.accountSubscriptions.entries()) {
      val.id = undefined;
    }
    this.stopHeartbeat();

    for (const cb of this.onDisconnectCallbacks) {
      try { cb(); } catch {}
    }

    if (!isManual && !this.isExplicitlyClosed && !this.isReconnectingInProgress) {
      this.scheduleAutoReconnect();
    }
  }

  private scheduleAutoReconnect(): void {
    if (this.isExplicitlyClosed || this.isReconnectingInProgress) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.stage = 'FAILED';
      this.lastReconnectResult = 'FAILED';
      return;
    }
    this.sessionTotalReconnectAttempts++;
    this.lastReconnectResult = 'PENDING';
    const delay = Math.min(
      this.backoffBaseMs * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 500,
      this.backoffMaxMs
    );
    this.reconnectAttempts++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isExplicitlyClosed && !this.isReconnectingInProgress) {
        this.connect();
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  public async manualReconnect(timeoutMs = 8000): Promise<boolean> {
    if (this.isReconnectingInProgress) {
      if (this.activeReconnectPromise) {
        return this.activeReconnectPromise;
      }
      return false;
    }

    this.isReconnectingInProgress = true;
    this.stage = 'RECONNECTING';
    this.lastManualAttemptFailed = false;
    this.sessionTotalReconnectAttempts++;
    this.lastReconnectResult = 'PENDING';

    this.activeReconnectPromise = (async () => {
      try {
        // 1. Cancel any pending automatic reconnect timer
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // 2. Safely close existing connection and invalidate socket generation
        if (this.ws) {
          const oldWs = this.ws;
          this.ws = null;
          const oldGen = this.socketGeneration;
          this.socketGeneration++;
          oldWs.removeAllListeners();
          try {
            oldWs.terminate();
          } catch {}
          this.handleDisconnect(oldGen, 'Manual reconnect requested', undefined, true);
        }

        // 3. Reset reconnect attempts & mark not explicitly closed
        this.reconnectAttempts = 0;
        this.isExplicitlyClosed = false;

        // 4. Connect fresh WebSocket with bounded timeout
        const connected = await this.connect(timeoutMs);
        if (!connected) {
          this.lastManualAttemptFailed = true;
          this.stage = 'FAILED';
          this.scheduleAutoReconnect();
        } else {
          this.lastManualAttemptFailed = false;
        }
        return connected;
      } catch (err: any) {
        this.lastManualAttemptFailed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.stage = 'FAILED';
        this.scheduleAutoReconnect();
        return false;
      } finally {
        this.isReconnectingInProgress = false;
        this.activeReconnectPromise = null;
      }
    })();

    return this.activeReconnectPromise;
  }

  public getConnectionStage(): WsConnectionStage {
    if (this.isExplicitlyClosed) return 'DISCONNECTED';
    if (this.isReconnectingInProgress) return 'RECONNECTING';
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      return this.lastManualAttemptFailed ? 'FAILED' : 'DISCONNECTED';
    }
    if (this.ws.readyState === WebSocket.CONNECTING) return 'CONNECTING';
    if (this.ws.readyState === WebSocket.OPEN) {
      const isFresh = (Date.now() - this.lastMessageTime) < (this.config.MAX_QUOTE_AGE_MS * 2 || 5000);
      if (this.currentSlot > 0 && isFresh) {
        return 'HEALTHY';
      }
      if (this.stage === 'RESTORING_SUBSCRIPTIONS' || this.stage === 'HYDRATING_POOLS') {
        return this.stage;
      }
      return 'CONNECTED';
    }
    return 'DISCONNECTED';
  }

  public getConnectionState(): WsConnectionState {
    const stage = this.getConnectionStage();
    if (stage === 'HEALTHY' || stage === 'CONNECTED') return 'CONNECTED';
    if (stage === 'RECONNECTING' || stage === 'CONNECTING' || stage === 'RESTORING_SUBSCRIPTIONS' || stage === 'HYDRATING_POOLS') {
      return 'RECONNECTING';
    }
    if (stage === 'FAILED') return 'FAILED';
    return 'DISCONNECTED';
  }

  public isReconnecting(): boolean {
    return this.isReconnectingInProgress;
  }

  public setHydratingPools(hydrating: boolean): void {
    if (hydrating && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.stage = 'HYDRATING_POOLS';
    } else if (!hydrating && this.stage === 'HYDRATING_POOLS') {
      this.stage = this.currentSlot > 0 ? 'HEALTHY' : 'CONNECTED';
    }
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  private subscribeSlot(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.subscriptionCounter++;
    this.reqIdForSlot = reqId;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: reqId,
      method: 'slotSubscribe',
      params: []
    }));
  }

  public subscribeAccount(pubkey: string, handler: AccountUpdateHandler): boolean {
    if (!this.accountSubscriptions.has(pubkey)) {
      if (this.maxSubscriptions > 0 && this.accountSubscriptions.size >= this.maxSubscriptions) {
        this.rejectedSubscriptionCount++;
        return false;
      }
      this.accountSubscriptions.set(pubkey, { handler });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.enqueueAccountSubscribe(pubkey);
      }
      return true;
    }
    this.accountSubscriptions.set(pubkey, { ...this.accountSubscriptions.get(pubkey)!, handler });
    return true;
  }

  private enqueueAccountSubscribe(pubkey: string): void {
    if (!this.subscriptionQueue.includes(pubkey)) {
      this.subscriptionQueue.push(pubkey);
    }
    this.drainSubscriptionQueue(this.socketGeneration);
  }

  private drainSubscriptionQueue(gen: number): void {
    if (this.pacingTimer) return;
    if (this.socketGeneration !== gen || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Send first bounded batch (up to 10) immediately
    const immediate = this.subscriptionQueue.splice(0, 10);
    for (const pubkey of immediate) {
      this.sendAccountSubscribe(pubkey);
    }

    if (this.subscriptionQueue.length === 0) return;

    // Pace remaining subscriptions in batches of up to 15 every 100ms
    this.pacingTimer = setInterval(() => {
      if (this.socketGeneration !== gen || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (this.pacingTimer) {
          clearInterval(this.pacingTimer);
          this.pacingTimer = null;
        }
        return;
      }
      const chunk = this.subscriptionQueue.splice(0, 15);
      for (const pubkey of chunk) {
        this.sendAccountSubscribe(pubkey);
      }
      if (this.subscriptionQueue.length === 0) {
        if (this.pacingTimer) {
          clearInterval(this.pacingTimer);
          this.pacingTimer = null;
        }
      }
    }, 100);
    this.pacingTimer.unref();
  }

  private sendAccountSubscribe(pubkey: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.subscriptionCounter++;
    this.reqIdToPubkey.set(reqId, pubkey);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: reqId,
      method: 'accountSubscribe',
      params: [
        pubkey,
        {
          encoding: 'base64',
          commitment: this.config.WS_COMMITMENT || 'processed'
        }
      ]
    }));
  }

  private getCloseCodeMeaning(code: number): string {
    switch (code) {
      case 1000: return 'Normal Closure';
      case 1001: return 'Going Away (Server restart/shutdown)';
      case 1002: return 'Protocol Error';
      case 1003: return 'Unsupported Data';
      case 1005: return 'No Status Received';
      case 1006: return 'Abnormal Closure (TCP drop / reset without close frame)';
      case 1007: return 'Invalid Frame Payload Data';
      case 1008: return 'Policy Violation (Rate limit / quota exceeded)';
      case 1009: return 'Message Too Big';
      case 1011: return 'Internal Server Error';
      case 1012: return 'Service Restart';
      case 1013: return 'Try Again Later';
      case 1015: return 'TLS Handshake Failure';
      default: return `Code ${code}`;
    }
  }

  private resubscribeAccountsPaced(gen: number): void {
    if (this.pacingTimer) {
      clearInterval(this.pacingTimer);
      this.pacingTimer = null;
    }
    this.subscriptionQueue = [];
    this.subscriptionQueue = [];
    const pubkeys = Array.from(this.accountSubscriptions.keys());
    if (pubkeys.length === 0) return;

    this.subscriptionQueue = [...pubkeys];
    this.drainSubscriptionQueue(gen);
  }

  private resubscribeAccounts(): void {
    this.resubscribeAccountsPaced(this.socketGeneration);
  }

  private handleMessage(rawMessage: string): void {
    this.messagesTotal++;
    try {
      const msg = JSON.parse(rawMessage);

      // Subscription confirmation result
      if (msg.id && typeof msg.result === 'number') {
        if (msg.id === this.reqIdForSlot) {
          this.slotSubId = msg.result;
          this.reqIdForSlot = null;
          return;
        }

        const pubkey = this.reqIdToPubkey.get(msg.id);
        if (pubkey) {
          const sub = this.accountSubscriptions.get(pubkey);
          if (sub) {
            sub.id = msg.result;
          }
          this.subIdToPubkey.set(msg.result, pubkey);
          this.reqIdToPubkey.delete(msg.id);
          return;
        }
        return;
      }

      // Subscription notifications
      if (msg.method === 'slotNotification') {
        const slot = msg.params?.result?.slot;
        if (typeof slot === 'number') {
          if (this.currentSlot > 0 && slot > this.currentSlot + 1) {
            const gap = slot - this.currentSlot - 1;
            this.slotGapCount++;
            this.totalSlotsSkipped += gap;
            this.maxSlotGap = Math.max(this.maxSlotGap, gap);
          }
          this.currentSlot = slot;
          for (const cb of this.onSlotCallbacks) {
            try { cb(slot); } catch {}
          }
        }
        return;
      }

      if (msg.method === 'accountNotification') {
        const receiptMonotonic = performance.now();
        const receiptMs = Date.now();
        const subId = msg.params?.subscription;
        const val = msg.params?.result?.value;
        const slot = msg.params?.result?.context?.slot || this.currentSlot;
        if (val && val.data && Array.isArray(val.data)) {
          const buffer = Buffer.from(val.data[0], 'base64');
          // Dispatch ONLY to the exact subscribed account handler
          const pubkey = this.subIdToPubkey.get(subId);
          if (pubkey) {
            this.activeAccountsWithUpdates.add(pubkey);
            const sub = this.accountSubscriptions.get(pubkey);
            if (sub) {
              sub.handler(buffer, slot, receiptMs, receiptMonotonic);
              return;
            }
          }

          // Secondary lookup by matching sub.id
          for (const [pk, sub] of this.accountSubscriptions.entries()) {
            if (sub.id === subId) {
              this.activeAccountsWithUpdates.add(pk);
              sub.handler(buffer, slot, receiptMs, receiptMonotonic);
              return;
            }
          }
          // Do NOT broadcast to arbitrary handlers if subId is unmapped
        }
      }
    } catch {
      // Ignore malformed json
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const silentMs = now - this.lastMessageTime;
      if (silentMs > 8000) {
        // Send WebSocket ping frame if connection has been quiet
        try {
          this.ws.ping();
        } catch {}
      }
      if (silentMs > 20000) {
        // Feed is stalled >20s; terminate to trigger clean reconnection
        const stallReason = `Feed stalled >20s without messages (${silentMs}ms silent)`;
        console.warn(`[SolanaWsProvider] ${stallReason}. Terminating socket for recovery.`);
        this.lastError = stallReason;
        try { this.ws.terminate(); } catch {}
      }
    }, 4000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public onReconnect(cb: () => void | Promise<void>): void {
    this.onReconnectCallbacks.push(cb);
  }

  public onDisconnect(cb: () => void): void {
    this.onDisconnectCallbacks.push(cb);
  }

  public onSlot(cb: SlotUpdateHandler): void {
    this.onSlotCallbacks.push(cb);
  }

  public getCurrentSlot(): number {
    return this.currentSlot;
  }

  public setSlot(slot: number): void {
    this.currentSlot = slot;
    this.lastMessageTime = Date.now();
    this.lastHealthyFeedTime = Date.now();
  }

  public getHealth(): FeedHealth {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return 'DISCONNECTED';
    }
    const elapsed = Date.now() - this.lastMessageTime;
    if (elapsed > this.config.MAX_QUOTE_AGE_MS * 2) {
      return 'STALE';
    }
    if (elapsed > 5000 || this.currentSlot === 0) {
      return 'DEGRADED';
    }
    return 'HEALTHY';
  }

  public getStats(): WsStats {
    const confirmedCount = Array.from(this.accountSubscriptions.values()).filter(s => s.id !== undefined).length;
    const now = Date.now();
    const healthyFeedAgeMs = this.lastHealthyFeedTime > 0 ? now - this.lastHealthyFeedTime : now - this.sessionStartTime;
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connectionState: this.getConnectionState(),
      connectionStage: this.getConnectionStage(),
      isReconnecting: this.isReconnectingInProgress,
      reconnectCount: this.sessionTotalReconnectAttempts,
      sessionTotalDisconnects: this.sessionTotalDisconnects,
      sessionTotalReconnectAttempts: this.sessionTotalReconnectAttempts,
      sessionTotalReconnectSuccesses: this.sessionTotalReconnectSuccesses,
      lastDisconnectCode: this.lastDisconnectCode,
      lastDisconnectReason: this.lastDisconnectReason,
      lastDisconnectTime: this.lastDisconnectTime,
      lastReconnectResult: this.lastReconnectResult,
      healthyFeedAgeMs,
      lastSlot: this.currentSlot,
      lastMessageTime: this.lastMessageTime,
      subscriptionCount: this.accountSubscriptions.size,
      confirmedSubscriptionCount: confirmedCount,
      rejectedSubscriptionCount: this.rejectedSubscriptionCount,
      maxSubscriptions: this.maxSubscriptions,
      activeAccountUpdatesCount: this.activeAccountsWithUpdates.size,
      slotGapCount: this.slotGapCount,
      totalSlotsSkipped: this.totalSlotsSkipped,
      maxSlotGap: this.maxSlotGap,
      totalDowntimeMs: this.totalDowntimeMs + (this.disconnectStartTime > 0 ? Date.now() - this.disconnectStartTime : 0),
      downtimeEventsCount: this.downtimeEventsCount,
      messagesTotal: this.messagesTotal,
      lastError: this.lastError
    };
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.isReconnectingInProgress = false;
    this.lastManualAttemptFailed = false;
    this.stopHeartbeat();
    if (this.pacingTimer) {
      clearInterval(this.pacingTimer);
      this.pacingTimer = null;
    }
    this.subscriptionQueue = [];
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
