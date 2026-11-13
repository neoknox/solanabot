export type QueuedEventType = 'POOL_ACCOUNT' | 'VAULT_ACCOUNT' | 'OPENORDERS_ACCOUNT' | 'TICK_ARRAY_ACCOUNT';

export interface QueuedAccountUpdate {
  type: QueuedEventType;
  key: string;            // poolId or vaultPubkey
  data: Buffer;
  slot: number;
  receivedAtMs: number;
  monotonicReceiptTime: number; // performance.now()
}

export interface EventQueueStats {
  queuedCount: number;
  processedCount: number;
  coalescedCount: number;
  droppedCount: number;
  peakQueueSize: number;
}

export class BoundedEventQueue {
  private maxCapacity: number;
  // Account Key -> Queued update for O(1) coalescing
  private keyedUpdates = new Map<string, QueuedAccountUpdate>();
  // FIFO order of account keys
  private queueOrder: string[] = [];

  private stats: EventQueueStats = {
    queuedCount: 0,
    processedCount: 0,
    coalescedCount: 0,
    droppedCount: 0,
    peakQueueSize: 0
  };

  private isDraining = false;

  constructor(maxCapacity = 2000) {
    this.maxCapacity = maxCapacity;
  }

  public enqueue(update: QueuedAccountUpdate): boolean {
    const queueKey = `${update.type}:${update.key}`;
    const existing = this.keyedUpdates.get(queueKey);

    if (existing) {
      // Coalescing: Only supersede if incoming slot is >= existing slot
      if (update.slot >= existing.slot) {
        this.keyedUpdates.set(queueKey, update);
        this.stats.coalescedCount++;
        return true;
      }
      // If incoming update is older than existing queued update, ignore stale update
      return false;
    }

    // Backpressure check
    if (this.queueOrder.length >= this.maxCapacity) {
      // Drop oldest queued key
      const oldestKey = this.queueOrder.shift();
      if (oldestKey) {
        this.keyedUpdates.delete(oldestKey);
        this.stats.droppedCount++;
      }
    }

    this.keyedUpdates.set(queueKey, update);
    this.queueOrder.push(queueKey);
    this.stats.queuedCount++;

    if (this.queueOrder.length > this.stats.peakQueueSize) {
      this.stats.peakQueueSize = this.queueOrder.length;
    }

    return true;
  }

  public dequeue(): QueuedAccountUpdate | undefined {
    const nextKey = this.queueOrder.shift();
    if (!nextKey) return undefined;

    const update = this.keyedUpdates.get(nextKey);
    if (update) {
      this.keyedUpdates.delete(nextKey);
      this.stats.processedCount++;
    }
    return update;
  }

  public drainAll(): QueuedAccountUpdate[] {
    const result: QueuedAccountUpdate[] = [];
    while (this.queueOrder.length > 0) {
      const item = this.dequeue();
      if (item) result.push(item);
    }
    return result;
  }

  public size(): number {
    return this.queueOrder.length;
  }

  public isEmpty(): boolean {
    return this.queueOrder.length === 0;
  }

  public clear(): void {
    this.keyedUpdates.clear();
    this.queueOrder = [];
  }

  public getStats(): EventQueueStats {
    return { ...this.stats, queuedCount: this.size() };
  }
}
