# Batch queue

`BatchQueue<T>` buffers items and hands them to your `onFlush` callback in batches: when the buffer reaches a size, on a timer, or on demand. It caps memory by dropping the oldest items. Use it inside a target that writes to a file or a network endpoint, where one write per entry is too slow.

It does **not** retry, requeue or drop a failed batch on its own. The owner decides, with `requeueFront()`.

## How it works

1. **Construct.** `new BatchQueue(options)` starts a `setInterval` of `flushIntervalMs` that calls `flush()`. The timer is `unref()`'d in Node, so it never keeps the process alive.
2. **Enqueue.** `enqueue(item)` appends, then enforces `maxQueue`: items past the cap are removed from the front (oldest) and passed to `onOverflow(droppedItems)`. When the buffer reaches `maxBatch`, `enqueue()` starts a flush and returns its promise; otherwise it resolves at once.
3. **Flush.** `flush()` returns the running flush when one is in flight, resolves at once on an empty buffer, else takes the whole buffer, empties it, and calls `onFlush(batch)`. With `exportTimeoutMs`, the flush rejects with `BatchQueue flush timed out after <ms>ms` when `onFlush` does not settle in time.
4. **Fail.** A rejection from `onFlush` reaches whoever awaits `flush()`, `forceFlush()` or the size-triggered `enqueue()`. The timer ignores it. The batch is gone from the buffer unless the owner calls `requeueFront(batch)`.
5. **Drain.** `forceFlush()` waits for a running flush, then flushes what is left. `shutdown()` stops the timer, runs `forceFlush()`, and turns `enqueue()` into a no-op.

## API

### `IBatchQueueOptions<T>`

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `maxBatch` | `number` | yes | Flush when the buffer holds this many items. |
| `maxQueue` | `number` | yes | Hard cap on buffered items; the oldest beyond it are dropped. |
| `flushIntervalMs` | `number` | yes | Timer period in ms. |
| `exportTimeoutMs` | `number` | no | Reject a flush whose `onFlush` takes longer. The `onFlush` work itself is not cancelled. |
| `onFlush` | `(items: T[]) => Promise<void>` | yes | Writes one batch. May reject. |
| `onOverflow` | `(droppedItems: T[]) => void` | no | Receives the dropped items, oldest first. |

### `BatchQueue<T>`

| Member | Meaning |
| --- | --- |
| `size` | Items in the buffer now (not counting a batch being flushed). |
| `enqueue(item): Promise<void>` | Add one item; see step 2. |
| `requeueFront(items)` | Put items back at the front, then enforce `maxQueue`. |
| `flush(): Promise<void>` | Flush the whole buffer in one `onFlush` call. |
| `forceFlush(): Promise<void>` | Wait for a running flush, then flush the rest. |
| `shutdown(): Promise<void>` | Stop the timer and do a final `forceFlush()`. |

## Services and extension points

`BatchQueue` is not a DI service; you construct it. Its extension points are the callbacks.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Batch delivery | None; one `new BatchQueue()` per target instance | none | Used by `FileTarget` (`@spinajs/log`), `OtlpLogTarget` (`@spinajs/log-otlp`), `GraphanaLogTarget` (`@spinajs/log-source-graphana-loki`) | `onFlush`: the I/O. `onOverflow`: what to do with dropped items (log a warning, forward to `OnDropped`). Catch in `onFlush` and call `requeueFront()` for never-drop delivery. |

### Using it in a custom target

The target below posts batches to an HTTP collector. Failed batches go back to the front of the queue, so nothing is lost while the collector is down until `maxQueue` is reached; entries dropped past the cap go to `OnDropped`, so a `FallbackGroupTarget` can write them to a file.

```ts sample
import { DI, IInstanceCheck, Injectable, PerInstanceCheck } from '@spinajs/di';
import { BatchQueue, createLogMessageObject, ICommonTargetOptions, ILogEntry, LogLevel, LogTarget, safeStringify } from '@spinajs/log-common';

interface IHttpBatchTargetOptions extends ICommonTargetOptions {
  options: { url: string; maxBatch?: number; maxQueue?: number; flushIntervalMs?: number };
}

@PerInstanceCheck()
@Injectable('HttpBatchTarget')
class HttpBatchTarget extends LogTarget<IHttpBatchTargetOptions> implements IInstanceCheck {
  protected Queue!: BatchQueue<ILogEntry>;

  public __checkInstance__(creationOptions: IHttpBatchTargetOptions[]): boolean {
    return this.Options.name === creationOptions[0].name;
  }

  public resolve(): void {
    const o = this.Options.options;
    this.Queue = new BatchQueue<ILogEntry>({
      maxBatch: o.maxBatch ?? 200,
      maxQueue: o.maxQueue ?? 20000,
      flushIntervalMs: o.flushIntervalMs ?? 2000,
      exportTimeoutMs: 10000,
      onFlush: (batch) => this.send(batch),
      onOverflow: (dropped) => dropped.forEach((entry) => this.OnDropped?.(entry)),
    });
    super.resolve();
  }

  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) return;
    void this.Queue.enqueue(entry).catch(() => undefined); // send() already handled it
  }

  public forceFlush(): Promise<void> {
    return this.Queue.forceFlush();
  }

  public async dispose(): Promise<void> {
    await this.Queue.shutdown();
  }

  private async send(batch: ILogEntry[]): Promise<void> {
    try {
      const response = await fetch(this.Options.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body: batch.map((e) => safeStringify({ ...e.Variables, severity: e.Level })).join('\n'),
      });
      if (!response.ok) throw new Error(`Collector responded ${response.status}`);
      this.HasError = false;
      this.Error = null;
    } catch (err) {
      this.HasError = true;
      this.Error = err;
      this.Queue.requeueFront(batch); // retried on the next tick
    }
  }
}

const target = DI.resolve<HttpBatchTarget>('HttpBatchTarget', [{ name: 'collector', type: 'HttpBatchTarget', options: { url: 'https://logs.example.com/ingest' } }]);
target.write(createLogMessageObject('Order %s shipped', '', LogLevel.Info, 'orders', {}, 'ORD-1'));
void target.forceFlush();
```

## Important behaviour

- Overflow is the only silent drop. A failed `onFlush` never drops items by itself, but the batch is no longer in the buffer: requeue it or it is lost.
- `requeueFront()` also enforces `maxQueue`, so requeuing during a long outage drops the oldest items and calls `onOverflow`.
- Only one `onFlush` runs at a time. Items enqueued during a flush wait for the next one; a size trigger during a flush returns the running flush's promise instead of starting another.
- An `exportTimeoutMs` timeout only rejects the promise. The in-flight guard clears, so the next flush can start while the slow `onFlush` still runs.
- The timer starts in the constructor. Create the queue in `resolve()` and stop it in `dispose()` with `shutdown()`, or a discarded target keeps flushing.
- After `shutdown()`, `enqueue()` resolves and discards the item.
- The queue is browser-safe: it uses only `setInterval` and `setTimeout`.

## Best practices

- Size `maxQueue` for the longest outage you want to survive at your peak rate; past it, entries go to `onOverflow`.
- Forward `onOverflow` items to `OnDropped` when your items are entries, so a fallback target can catch them. Targets that buffer rendered strings (like `FileTarget`) cannot, and log a warning instead.
- Implement `forceFlush()` as `Queue.forceFlush()`, so `Log.flush()` and shutdown drains reach the buffer.

## Patterns and antipatterns

```ts
// Don't: the batch is gone from the buffer; a failure loses it without a trace.
onFlush: async (batch) => { await post(batch).catch(() => undefined); }

// Do: put it back, and let maxQueue bound memory.
onFlush: async (batch) => {
  try {
    await post(batch);
  } catch {
    queue.requeueFront(batch);
  }
}
```

## Related

- [Log targets](06-log-targets.md): `forceFlush()`, `dispose()` and `OnDropped`.
- [`@spinajs/log`](../log/README.md): `FileTarget` and `FallbackGroupTarget`.
