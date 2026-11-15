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
  lastSlot: number;
  lastMessageTime: number;
  subscriptionCount: number;
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
  private socketGeneration = 0;
  private stage: WsConnectionStage = 'STANDBY';
  private lastError: string | null = null;

  private currentSlot = 0;
  private lastMessageTime = 0;
  private subscriptionCounter = 1;
  private accountSubscriptions = new Map<string, { id?: number; handler: AccountUpdateHandler }>();
  private subIdToPubkey = new Map<number, string>();
  private reqIdToPubkey = new Map<number, string>();
  private reqIdForSlot: number | null = null;
  private slotSubId: number | null = null;
  private messagesTotal = 0;

  private onReconnectCallbacks: Array<() => void | Promise<void>> = [];
  private onDisconnectCallbacks: Array<() => void> = [];
  private onSlotCallbacks: Array<SlotUpdateHandler> = [];

  constructor(config: AppConfig) {
    this.config = config;
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
              this.lastError = `Connection timeout (${timeoutMs}ms) exceeded`;
              try { this.ws?.terminate(); } catch {}
              this.handleDisconnect();
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
          this.reconnectAttempts = 0;
          this.lastManualAttemptFailed = false;
          this.lastMessageTime = Date.now();
          this.lastError = null;
          this.stage = 'CONNECTED';

          // 1. Resolve connect promise immediately once transport is open
          finish(true);

          // 2. Advance to restoring subscriptions
          this.stage = 'RESTORING_SUBSCRIPTIONS';
          this.subscribeSlot();
          this.resubscribeAccountsPaced(currentGen);
          this.startHeartbeat();

          // 3. Trigger reconnect callbacks in background without blocking connect()
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
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          if (this.socketGeneration !== currentGen) return;
          this.lastMessageTime = Date.now();
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (err) => {
          if (this.socketGeneration !== currentGen) return;
          const errMsg = err instanceof Error ? err.message : String(err);
          this.lastError = errMsg;
          console.warn(`[SolanaWsProvider] WebSocket error: ${errMsg}`);
        });

        this.ws.on('close', () => {
          if (this.socketGeneration !== currentGen) return;
          this.stage = 'DISCONNECTED';
          this.handleDisconnect();
          finish(false);
        });
      } catch (err: any) {
        if (this.socketGeneration === currentGen) {
          this.lastError = err?.message || String(err);
          this.stage = 'DISCONNECTED';
          this.handleDisconnect();
        }
        finish(false);
      }
    });
  }

  private handleDisconnect(isManual = false): void {
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
    if (!this.isExplicitlyClosed && !this.isReconnectingInProgress && this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(
        this.backoffBaseMs * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 500,
        this.backoffMaxMs
      );
      this.reconnectAttempts++;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, delay);
      this.reconnectTimer.unref();
    }
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
          this.socketGeneration++;
          oldWs.removeAllListeners();
          try {
            oldWs.terminate();
          } catch {}
          this.handleDisconnect(true);
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

  public subscribeAccount(pubkey: string, handler: AccountUpdateHandler): void {
    this.accountSubscriptions.set(pubkey, { handler });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendAccountSubscribe(pubkey);
    }
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

  private resubscribeAccountsPaced(gen: number): void {
    const pubkeys = Array.from(this.accountSubscriptions.keys());
    if (pubkeys.length === 0) return;

    // Send first batch of up to 10 immediately
    const immediate = pubkeys.slice(0, 10);
    for (const pubkey of immediate) {
      if (this.socketGeneration !== gen || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.sendAccountSubscribe(pubkey);
    }

    if (pubkeys.length <= 10) return;

    // Pace remaining subscriptions in batches of 10 every 50ms to prevent RPC socket drops
    let index = 10;
    const interval = setInterval(() => {
      if (this.socketGeneration !== gen || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        return;
      }
      const chunk = pubkeys.slice(index, index + 10);
      for (const pubkey of chunk) {
        this.sendAccountSubscribe(pubkey);
      }
      index += 10;
      if (index >= pubkeys.length) {
        clearInterval(interval);
      }
    }, 50);
    interval.unref();
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
            const sub = this.accountSubscriptions.get(pubkey);
            if (sub) {
              sub.handler(buffer, slot, receiptMs, receiptMonotonic);
              return;
            }
          }

          // Secondary lookup by matching sub.id
          for (const sub of this.accountSubscriptions.values()) {
            if (sub.id === subId) {
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
      if (now - this.lastMessageTime > 20000 && this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Feed is stalled; terminate to trigger clean reconnection
        console.warn('[SolanaWsProvider] Feed stalled >20s without messages. Terminating socket for recovery.');
        this.ws.terminate();
      }
    }, 5000);
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
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connectionState: this.getConnectionState(),
      connectionStage: this.getConnectionStage(),
      isReconnecting: this.isReconnectingInProgress,
      reconnectCount: this.reconnectAttempts,
      lastSlot: this.currentSlot,
      lastMessageTime: this.lastMessageTime,
      subscriptionCount: this.accountSubscriptions.size,
      messagesTotal: this.messagesTotal,
      lastError: this.lastError
    };
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.isReconnectingInProgress = false;
    this.lastManualAttemptFailed = false;
    this.stopHeartbeat();
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
