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

export type WsConnectionState = 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'FAILED';

export interface WsStats {
  connected: boolean;
  reconnectCount: number;
  lastSlot: number;
  lastMessageTime: number;
  subscriptionCount: number;
  messagesTotal?: number;
  connectionState?: WsConnectionState;
  isReconnecting?: boolean;
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

  public connect(timeoutMs = 10000): Promise<boolean> {
    this.isExplicitlyClosed = false;
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
            try { this.ws?.terminate(); } catch {}
            this.handleDisconnect();
            finish(false);
          }
        }, timeoutMs);
      }

      try {
        this.ws = new WebSocket(this.config.SOLANA_RPC_WS);

        this.ws.on('open', async () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          this.reconnectAttempts = 0;
          this.lastManualAttemptFailed = false;
          this.lastMessageTime = Date.now();
          this.subscribeSlot();
          this.resubscribeAccounts();
          this.startHeartbeat();
          for (const cb of this.onReconnectCallbacks) {
            try {
              const res = cb();
              if (res && typeof (res as Promise<any>).then === 'function') {
                await res;
              }
            } catch {}
          }
          finish(true);
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.lastMessageTime = Date.now();
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (_err) => {
          // Handled in on('close')
        });

        this.ws.on('close', () => {
          this.handleDisconnect();
          finish(false);
        });
      } catch {
        this.handleDisconnect();
        finish(false);
      }
    });
  }

  private handleDisconnect(): void {
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

    if (!this.isExplicitlyClosed && !this.isReconnectingInProgress) {
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
    }
  }

  public async manualReconnect(timeoutMs = 10000): Promise<boolean> {
    if (this.isReconnectingInProgress) {
      if (this.activeReconnectPromise) {
        return this.activeReconnectPromise;
      }
      return false;
    }

    this.isReconnectingInProgress = true;
    this.lastManualAttemptFailed = false;

    this.activeReconnectPromise = (async () => {
      try {
        // 1. Cancel any pending automatic reconnect timer
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // 2. Safely close existing connection
        if (this.ws) {
          const oldWs = this.ws;
          this.ws = null;
          oldWs.removeAllListeners();
          try {
            oldWs.terminate();
          } catch {}
          this.handleDisconnect();
        }

        // 3. Reset reconnect attempts & mark not explicitly closed
        this.reconnectAttempts = 0;
        this.isExplicitlyClosed = false;

        // 4. Connect fresh WebSocket
        const connected = await this.connect(timeoutMs);
        if (!connected) {
          this.lastManualAttemptFailed = true;
          this.scheduleAutoReconnect();
        } else {
          this.lastManualAttemptFailed = false;
        }
        return connected;
      } catch {
        this.lastManualAttemptFailed = true;
        this.scheduleAutoReconnect();
        return false;
      } finally {
        this.isReconnectingInProgress = false;
        this.activeReconnectPromise = null;
      }
    })();

    return this.activeReconnectPromise;
  }

  public getConnectionState(): WsConnectionState {
    if (this.isReconnectingInProgress) {
      return 'RECONNECTING';
    }
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      return 'CONNECTED';
    }
    if (this.lastManualAttemptFailed) {
      return 'FAILED';
    }
    return 'DISCONNECTED';
  }

  public isReconnecting(): boolean {
    return this.isReconnectingInProgress;
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

  private resubscribeAccounts(): void {
    for (const pubkey of this.accountSubscriptions.keys()) {
      this.sendAccountSubscribe(pubkey);
    }
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
        this.ws.terminate();
      }
    }, 5000);
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
    if (elapsed > 5000) {
      return 'DEGRADED';
    }
    return 'HEALTHY';
  }

  public getStats(): WsStats {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connectionState: this.getConnectionState(),
      isReconnecting: this.isReconnectingInProgress,
      reconnectCount: this.reconnectAttempts,
      lastSlot: this.currentSlot,
      lastMessageTime: this.lastMessageTime,
      subscriptionCount: this.accountSubscriptions.size,
      messagesTotal: this.messagesTotal
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
