import WebSocket from 'ws';
import { FeedHealth } from '../types/index.js';
import { AppConfig } from '../config/index.js';

export type AccountUpdateHandler = (accountData: Buffer, slot: number) => void;
export type SlotUpdateHandler = (slot: number) => void;

export interface WsStats {
  connected: boolean;
  reconnectCount: number;
  lastSlot: number;
  lastMessageTime: number;
  subscriptionCount: number;
}

export class SolanaWsProvider {
  private ws: WebSocket | null = null;
  private config: AppConfig;
  private isExplicitlyClosed = false;
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
  private slotSubId: number | null = null;

  private onReconnectCallbacks: Array<() => void> = [];
  private onDisconnectCallbacks: Array<() => void> = [];
  private onSlotCallbacks: Array<SlotUpdateHandler> = [];

  constructor(config: AppConfig) {
    this.config = config;
  }

  public connect(): Promise<boolean> {
    this.isExplicitlyClosed = false;
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.config.SOLANA_RPC_WS);

        this.ws.on('open', () => {
          this.reconnectAttempts = 0;
          this.lastMessageTime = Date.now();
          this.subscribeSlot();
          this.resubscribeAccounts();
          this.startHeartbeat();
          for (const cb of this.onReconnectCallbacks) {
            try { cb(); } catch {}
          }
          resolve(true);
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
          resolve(false);
        });
      } catch {
        this.handleDisconnect();
        resolve(false);
      }
    });
  }

  private handleDisconnect(): void {
    this.slotSubId = null;
    this.subIdToPubkey.clear();
    for (const [key, val] of this.accountSubscriptions.entries()) {
      val.id = undefined;
    }
    this.stopHeartbeat();

    for (const cb of this.onDisconnectCallbacks) {
      try { cb(); } catch {}
    }

    if (!this.isExplicitlyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
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

  private subscribeSlot(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.subscriptionCounter++;
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
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: reqId,
      method: 'accountSubscribe',
      params: [
        pubkey,
        {
          encoding: 'base64',
          commitment: 'confirmed'
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
    try {
      const msg = JSON.parse(rawMessage);

      // Subscription confirmation result
      if (msg.id && typeof msg.result === 'number') {
        // Could be slot or account sub
        if (this.slotSubId === null) {
          this.slotSubId = msg.result;
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
        const subId = msg.params?.subscription;
        const val = msg.params?.result?.value;
        const slot = msg.params?.result?.context?.slot || this.currentSlot;
        if (val && val.data && Array.isArray(val.data)) {
          const buffer = Buffer.from(val.data[0], 'base64');
          // If we mapped subId, notify that specific handler, or broadcast to matching accounts
          for (const sub of this.accountSubscriptions.values()) {
            if (sub.id === subId) {
              sub.handler(buffer, slot);
              return;
            }
          }
          // Fallback if subId wasn't mapped explicitly
          for (const sub of this.accountSubscriptions.values()) {
            sub.handler(buffer, slot);
          }
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

  public onReconnect(cb: () => void): void {
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
      reconnectCount: this.reconnectAttempts,
      lastSlot: this.currentSlot,
      lastMessageTime: this.lastMessageTime,
      subscriptionCount: this.accountSubscriptions.size
    };
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
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
