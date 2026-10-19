/**
 * Wraps an async factory so it runs at most once at a time and its result is shared. A rejection is not kept:
 * the next call runs the factory again.
 *
 * @example
 * const connect = onceAsync(() => openConnection());
 * await Promise.all([connect(), connect()]); // openConnection runs once
 */
export function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending === undefined) {
      const mine = attempt(fn).catch((err: unknown) => {
        if (pending === mine) pending = undefined;
        throw err;
      });
      pending = mine;
    }
    return pending;
  };
}

/** The part of a `Map` that {@link memoizeAsync} and {@link singleFlight} use. */
export interface PromiseMap<K, V> {
  get(key: K): Promise<V> | undefined;
  set(key: K, value: Promise<V>): unknown;
  delete(key: K): unknown;
}

/**
 * The promise held under `key` in `map`, or `load()` stored there. A rejected promise is removed, so the next call
 * loads again; a fulfilled one stays until the map drops it.
 */
export function memoizeAsync<K, V>(map: PromiseMap<K, V>, key: K, load: () => Promise<V>): Promise<V> {
  const held = map.get(key);
  if (held !== undefined) return held;
  const loading = attempt(load);
  map.set(key, loading);
  loading.catch(() => {
    if (map.get(key) === loading) map.delete(key);
  });
  return loading;
}

/**
 * Concurrent calls for one `key` share the load in flight; once it settles, either way, the next call loads again.
 * `map` holds only the loads in flight.
 */
export function singleFlight<K, V>(map: PromiseMap<K, V>, key: K, load: () => Promise<V>): Promise<V> {
  const held = map.get(key);
  if (held !== undefined) return held;
  const loading = attempt(load);
  map.set(key, loading);
  const settle = () => {
    if (map.get(key) === loading) map.delete(key);
  };
  loading.then(settle, settle);
  return loading;
}

/**
 * Runs tasks one at a time per key, in call order. A failed task does not stop the next one. A key is forgotten as
 * soon as its queue is empty.
 */
export class KeyedMutex<K = string> {
  private readonly tails = new Map<K, Promise<unknown>>();

  /** Keys with a task running or waiting. */
  get size(): number {
    return this.tails.size;
  }

  async runExclusive<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const run = () => fn();
    const mine = (this.tails.get(key) ?? Promise.resolve()).then(run, run);
    const tail = mine.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await mine;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Background work that runs after the caller has its answer. Each task starts on a later turn of the event loop;
 * its error goes to `onError` and never reaches the caller. {@link TaskTracker.drain} waits for everything
 * scheduled so far, including work scheduled while draining.
 */
export class TaskTracker {
  private readonly pending = new Set<Promise<void>>();

  /** @param onError - reporter for a failed task ( defaults to `console.error` ); its own throws are ignored */
  constructor(private readonly onError: (err: unknown) => void = (err) => console.error('Deferred task failed', err)) {}

  /** Tasks scheduled and not yet settled. */
  get size(): number {
    return this.pending.size;
  }

  defer(work: () => Promise<void>): void {
    const p: Promise<void> = laterTurn()
      .then(work)
      .catch((err: unknown) => {
        try {
          this.onError(err);
        } catch {
          // a failing reporter must not turn into an unhandled rejection
        }
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}

/** The outcome of {@link settleWithin}; `brokenThenable` marks a `then()` that threw instead of rejecting. */
export type SettledWithin<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown; readonly brokenThenable?: true }
  | { readonly status: 'timeout' };

/**
 * Waits at most `ms` for `p` and never rejects. Unlike {@link withTimeout} a timeout is a result, not an error;
 * a result that comes later is ignored and its rejection caught. The underlying work is not cancelled.
 */
export function settleWithin<T>(p: PromiseLike<T>, ms: number): Promise<SettledWithin<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s: SettledWithin<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), ms);
    try {
      p.then(
        (value) => finish({ status: 'fulfilled', value }),
        (reason: unknown) => finish({ status: 'rejected', reason }),
      );
    } catch (reason) {
      finish({ status: 'rejected', reason, brokenThenable: true });
    }
  });
}

/**
 * One time limit shared by several steps of an operation. The timer starts in the constructor; call
 * {@link Deadline.clear} when the operation ends.
 */
export class Deadline {
  static readonly EXPIRED: unique symbol = Symbol('deadline expired');

  expired = false;
  private readonly reached: Promise<typeof Deadline.EXPIRED>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly ms: number) {
    this.reached = new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.expired = true;
        resolve(Deadline.EXPIRED);
      }, ms);
    });
  }

  /** `work`'s result, or {@link Deadline.EXPIRED} when the limit comes first; `work` is left running. */
  race<T>(work: Promise<T>): Promise<T | typeof Deadline.EXPIRED> {
    if (!this.expired) return Promise.race([work, this.reached]);
    swallow(work);
    return Promise.resolve(Deadline.EXPIRED);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

/** A synchronous throw becomes a rejection, so callers always get a promise. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function laterTurn(): Promise<void> {
  return new Promise<void>((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));
}

function swallow(p: PromiseLike<unknown>): void {
  try {
    p.then(undefined, () => undefined);
  } catch {
    // a thenable whose then() throws has nothing left to reject
  }
}
