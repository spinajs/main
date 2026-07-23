import "mocha";
import { expect } from "chai";
import { BatchQueue, IBatchQueueOptions } from "../src/index.js";

/** Small helper: resolve after `ms` ms of real time. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a BatchQueue with sensible test defaults ( large caps, a long timer so
 * the periodic tick never interferes ) plus a spy `onFlush` that records every
 * batch it receives. Overrides win over the defaults.
 */
function makeQueue<T>(overrides: Partial<IBatchQueueOptions<T>> = {}) {
  const batches: T[][] = [];

  const onFlush =
    overrides.onFlush ??
    ((items: T[]) => {
      batches.push(items);
      return Promise.resolve();
    });

  const options: IBatchQueueOptions<T> = {
    maxBatch: 10,
    maxQueue: 1000,
    flushIntervalMs: 10_000,
    onFlush,
    ...overrides,
  };

  const queue = new BatchQueue<T>(options);
  return { queue, batches, options };
}

describe("BatchQueue", () => {
  it("does NOT call onFlush below maxBatch until flush()/forceFlush()", async () => {
    const { queue, batches } = makeQueue<number>({ maxBatch: 5 });

    await queue.enqueue(1);
    await queue.enqueue(2);
    await queue.enqueue(3);

    expect(batches.length).to.eq(0);
    expect(queue.size).to.eq(3);

    await queue.forceFlush();

    expect(batches.length).to.eq(1);
    expect(batches[0]).to.deep.eq([1, 2, 3]);
    expect(queue.size).to.eq(0);

    await queue.shutdown();
  });

  it("flushes at maxBatch with exactly the buffered items in order; triggering enqueue awaits the flush", async () => {
    let flushed: number[] | null = null;
    const { queue } = makeQueue<number>({
      maxBatch: 3,
      onFlush: (items) => {
        flushed = items;
        return Promise.resolve();
      },
    });

    await queue.enqueue(1);
    await queue.enqueue(2);
    // This enqueue reaches maxBatch=3 and its returned promise must await the flush.
    await queue.enqueue(3);

    expect(flushed).to.deep.eq([1, 2, 3]);
    expect(queue.size).to.eq(0);

    await queue.shutdown();
  });

  it("drops OLDEST past maxQueue and calls onOverflow(droppedItems); size never exceeds maxQueue", async () => {
    // each overflow episode's dropped ITEMS array, captured in order.
    const droppedBatches: number[][] = [];
    // maxBatch high so pushes don't auto-flush; we only exercise the cap.
    const { queue, batches } = makeQueue<number>({
      maxBatch: 1000,
      maxQueue: 3,
      onOverflow: (items) => droppedBatches.push(items),
    });

    for (let i = 1; i <= 5; i++) {
      await queue.enqueue(i);
      expect(queue.size).to.be.at.most(3);
    }

    // 5 pushed, cap 3 -> two overflow episodes, each dropping one OLDEST item:
    // first drops [1] ( when 4th arrives ), then [2] ( when 5th arrives ). The
    // callback receives the dropped ITEMS array, not just a count.
    expect(droppedBatches).to.deep.eq([[1], [2]]);
    // total dropped item count is derivable from the arrays.
    expect(droppedBatches.reduce((n, b) => n + b.length, 0)).to.eq(2);
    expect(queue.size).to.eq(3);

    await queue.forceFlush();
    expect(batches[0]).to.deep.eq([3, 4, 5]);

    await queue.shutdown();
  });

  it("onOverflow receives the SAME item objects that were dropped ( identity )", async () => {
    const dropped: object[] = [];
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };

    const { queue } = makeQueue<object>({
      maxBatch: 1000,
      maxQueue: 2,
      onOverflow: (items) => dropped.push(...items),
    });

    await queue.enqueue(a);
    await queue.enqueue(b);
    await queue.enqueue(c); // over cap 2 -> drops oldest ( a )

    expect(dropped).to.have.length(1);
    // identity, not just deep-equality: the exact object is handed back so an
    // owner can route it ( eg. to a fallback ) without reconstruction.
    expect(dropped[0]).to.eq(a);

    await queue.shutdown();
  });

  it("coalesces overlapping flush() calls into ONE onFlush ( re-entrancy guard )", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { queue } = makeQueue<number>({
      maxBatch: 1000,
      onFlush: async () => {
        calls++;
        await gate; // hold the flush open so the second flush() overlaps it
      },
    });

    await queue.enqueue(1);
    await queue.enqueue(2);

    const f1 = queue.flush();
    const f2 = queue.flush();

    expect(f1).to.eq(f2); // same in-flight promise returned
    expect(calls).to.eq(1);

    release();
    await Promise.all([f1, f2]);
    expect(calls).to.eq(1);

    await queue.shutdown();
  });

  it("requeueFront puts a failed batch back at the front, delivered first in order on next flush", async () => {
    const seen: number[][] = [];
    let fail = true;

    const { queue } = makeQueue<number>({
      maxBatch: 1000,
      onFlush: (items) => {
        if (fail) {
          return Promise.reject(new Error("sink down"));
        }
        seen.push(items);
        return Promise.resolve();
      },
    });

    await queue.enqueue(1);
    await queue.enqueue(2);

    // First flush fails; owner catches and requeues the batch at the front.
    let caught: Error | null = null;
    try {
      await queue.flush();
    } catch (e) {
      caught = e as Error;
      queue.requeueFront([1, 2]);
    }
    expect(caught).to.be.instanceOf(Error);

    // New items arrive after the requeued ones.
    await queue.enqueue(3);

    fail = false;
    await queue.forceFlush();

    expect(seen).to.deep.eq([[1, 2, 3]]);

    await queue.shutdown();
  });

  it("does not wedge on onFlush rejection: awaiting caller sees the rejection; a later flush still runs onFlush", async () => {
    let fail = true;
    const good: number[][] = [];

    const { queue } = makeQueue<number>({
      maxBatch: 1000,
      onFlush: (items) => {
        if (fail) {
          return Promise.reject(new Error("boom"));
        }
        good.push(items);
        return Promise.resolve();
      },
    });

    await queue.enqueue(1);

    let rejected = false;
    try {
      await queue.flush();
    } catch {
      rejected = true;
    }
    expect(rejected).to.eq(true);

    // Guard must be cleared -> a fresh enqueue + flush invokes onFlush again.
    fail = false;
    await queue.enqueue(2);
    await queue.forceFlush();

    expect(good).to.deep.eq([[2]]);

    await queue.shutdown();
  });

  it("periodic timer flushes buffered items without an explicit flush call", async () => {
    const batches: number[][] = [];
    const { queue } = makeQueue<number>({
      maxBatch: 1000,
      flushIntervalMs: 20,
      onFlush: (items) => {
        batches.push(items);
        return Promise.resolve();
      },
    });

    await queue.enqueue(42);
    expect(batches.length).to.eq(0);

    await sleep(60);

    expect(batches.length).to.be.at.least(1);
    expect(batches[0]).to.deep.eq([42]);

    await queue.shutdown();
  });

  it("exportTimeoutMs: an onFlush that never settles causes flush() to reject after the timeout", async () => {
    const { queue } = makeQueue<number>({
      maxBatch: 1000,
      exportTimeoutMs: 30,
      onFlush: () => new Promise<void>(() => { /* never settles */ }),
    });

    await queue.enqueue(1);

    let err: Error | null = null;
    try {
      await queue.flush();
    } catch (e) {
      err = e as Error;
    }

    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/timed out/i);

    // Guard cleared after the timeout rejection -> queue still usable.
    // ( don't shutdown via forceFlush of the never-settling flush; buffer is empty now )
    await queue.shutdown();
  });

  it("shutdown stops the timer, performs a final flush, and makes enqueue a no-op", async () => {
    const batches: number[][] = [];
    const { queue } = makeQueue<number>({
      maxBatch: 1000,
      flushIntervalMs: 20,
      onFlush: (items) => {
        batches.push(items);
        return Promise.resolve();
      },
    });

    await queue.enqueue(1);
    await queue.enqueue(2);

    await queue.shutdown();

    // Final flush drained the buffer.
    expect(batches).to.deep.eq([[1, 2]]);
    expect(queue.size).to.eq(0);

    // Post-shutdown enqueue is a no-op that resolves.
    await queue.enqueue(3);
    expect(queue.size).to.eq(0);

    // Timer no longer flushes anything.
    const before = batches.length;
    await sleep(60);
    expect(batches.length).to.eq(before);
  });
});
