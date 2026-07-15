/**
 * A small, dependency-free, browser-safe buffered-batch queue.
 *
 * `BatchQueue<T>` owns ACCUMULATION and FLUSH TRIGGERING only; it delegates the
 * actual I/O to the owner via `onFlush`. Ported from the essence of
 * OpenTelemetry's BatchLogRecordProcessor.
 *
 * Triggers a flush when either:
 *  - the buffer reaches `maxBatch` items ( size trigger ), or
 *  - the periodic timer fires every `flushIntervalMs` ( interval trigger ).
 *
 * ## Failure model
 *
 * There are two, deliberately distinct, ways items can leave the queue:
 *
 *  1. **Overflow ( the ONLY silent drop ).** The buffer is hard-capped at
 *     `maxQueue`. When it grows past the cap the OLDEST items are dropped so
 *     memory stays bounded, and `onOverflow(droppedItems)` fires. This is the
 *     back-pressure release valve for a stuck/slow sink.
 *
 *  2. **Flush failure ( never a silent drop ).** `onFlush` may throw / reject.
 *     `BatchQueue` does NOT retry, requeue, or swallow the batch on its own —
 *     that is the owner's decision. The rejection PROPAGATES to any caller that
 *     awaits `flush()` / `forceFlush()`, so the owner can `catch` it and call
 *     `requeueFront(batch)` to put the batch back at the front ( never-drop
 *     semantics ) or drop it deliberately. The periodic timer intentionally
 *     ignores the rejection ( `void this.flush()` ) so a failing sink never
 *     kills the flush loop; the in-flight guard is always cleared in `finally`
 *     so the next flush can proceed regardless of outcome.
 *
 * ## Re-entrancy
 *
 * At most one `onFlush` runs at a time. If a flush is already in flight, calling
 * `flush()` returns the SAME in-flight promise ( coalesced ) rather than
 * starting a second `onFlush`. A flush snapshots and clears the buffer
 * synchronously before awaiting the I/O, so items enqueued during a flush land
 * in a fresh buffer and are picked up by the next flush.
 *
 * ## Runtime
 *
 * Uses only `setInterval` / `setTimeout` ( available in both Node and browsers ).
 * The periodic timer ( and the optional per-flush timeout timer ) are `unref()`'d
 * when that method exists, so they never keep a Node process alive; the `?.`
 * guard makes the calls harmless in browsers.
 */
export interface IBatchQueueOptions<T> {
  /** Flush automatically once the buffer reaches this many items. */
  maxBatch: number;
  /** Hard cap on buffered items. Beyond it the OLDEST are dropped ( onOverflow fires ). */
  maxQueue: number;
  /** Periodic flush tick in ms. The timer is unref()'d so it never blocks process exit. */
  flushIntervalMs: number;
  /** Optional per-flush timeout in ms. If onFlush does not settle in time, the flush rejects. */
  exportTimeoutMs?: number;
  /** Does the actual I/O for a batch. May throw/reject; the owner handles retry/requeue/drop. */
  onFlush: (items: T[]) => Promise<void>;
  /**
   * Called when the queue cap is exceeded and the oldest items are dropped.
   * Receives the DROPPED ITEMS themselves ( oldest first ) so an owner can route
   * exactly what was dropped to a fallback ( see LogTarget.OnDropped ). Use
   * `droppedItems.length` when only the count matters.
   */
  onOverflow?: (droppedItems: T[]) => void;
}

export class BatchQueue<T> {
  private buffer: T[] = [];

  private timer: ReturnType<typeof setInterval>;

  private stopped = false;

  /**
   * The currently running flush, or null when idle. Used both as the
   * re-entrancy guard ( coalesce concurrent flush() calls ) and to let
   * forceFlush()/shutdown() wait for an in-flight flush before draining.
   */
  private inFlight: Promise<void> | null = null;

  constructor(private options: IBatchQueueOptions<T>) {
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    // Do not keep the event loop / process alive just for the flush tick.
    this.timer.unref?.();
  }

  /** Current number of buffered items. */
  public get size(): number {
    return this.buffer.length;
  }

  /**
   * Add an item to the buffer.
   *
   * If the queue has been shut down this is a no-op that resolves immediately.
   * When the buffer reaches `maxBatch` a flush is triggered and its promise is
   * returned, so a caller MAY await a size-triggered flush; otherwise resolves
   * immediately.
   */
  public enqueue(item: T): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }

    this.buffer.push(item);
    this.enforceCap();

    if (this.size >= this.options.maxBatch) {
      return this.flush();
    }

    return Promise.resolve();
  }

  /**
   * Put items back at the FRONT of the buffer ( then enforce the cap ). Owners
   * use this to re-queue a batch whose `onFlush` failed, without dropping it.
   */
  public requeueFront(items: T[]): void {
    this.buffer = [...items, ...this.buffer];
    this.enforceCap();
  }

  /**
   * Enforce the hard `maxQueue` cap by dropping the OLDEST items. Fires
   * `onOverflow(droppedItems)` with the spliced-out items when anything is dropped.
   */
  private enforceCap(): void {
    if (this.buffer.length > this.options.maxQueue) {
      const dropCount = this.buffer.length - this.options.maxQueue;
      const droppedItems = this.buffer.splice(0, dropCount);
      this.options.onOverflow?.(droppedItems);
    }
  }

  /**
   * Flush the entire buffer in a single `onFlush` call.
   *
   * Re-entrancy: if a flush is already in flight, that same promise is returned
   * ( no second `onFlush` ). If the buffer is empty, resolves immediately.
   * Otherwise the buffer is snapshotted and cleared synchronously, `onFlush`
   * runs ( optionally raced against `exportTimeoutMs` ), and the in-flight guard
   * is cleared in `finally` regardless of success or failure. The returned
   * promise settles with `onFlush`'s outcome so an awaiting owner can catch a
   * rejection and requeue.
   */
  public flush(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    if (this.buffer.length === 0) {
      return Promise.resolve();
    }

    const batch = this.buffer;
    this.buffer = [];

    const run = this.options.exportTimeoutMs !== undefined ? this.withTimeout(this.options.onFlush(batch), this.options.exportTimeoutMs) : this.options.onFlush(batch);

    // Store as the guard and clear it once settled ( success OR failure ) so the
    // next flush can proceed. The promise is still returned to the caller so the
    // rejection propagates for owner-side handling.
    this.inFlight = run.finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /**
   * Race a flush promise against a timeout that rejects after `ms`. The timeout
   * timer is cleared ( and unref()'d ) so it neither leaks nor keeps the loop alive.
   */
  private withTimeout(promise: Promise<void>, ms: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout>;

    const timer = new Promise<void>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`BatchQueue flush timed out after ${ms}ms`)), ms);
      timeout.unref?.();
    });

    return Promise.race([promise, timer]).finally(() => {
      clearTimeout(timeout);
    });
  }

  /**
   * Flush any buffered items and await completion. If a flush is already in
   * flight, wait for it first, then flush any remainder that accumulated. Since
   * a single `flush()` drains the ENTIRE buffer, one follow-up flush suffices.
   */
  public async forceFlush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
    }

    await this.flush();
  }

  /**
   * Stop the periodic timer and perform a best-effort final flush of buffered
   * items. After shutdown, `enqueue` is a no-op that resolves.
   */
  public async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.forceFlush();
  }
}
