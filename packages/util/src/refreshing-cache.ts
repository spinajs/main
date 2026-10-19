import { InvalidArgument } from '@spinajs/exceptions';

import type { Clock } from './clock.js';

export interface RefreshingCacheOptions<T> {
  /** Fetches a new value; `now` is the time of the call that started the load. */
  readonly load: (now: number) => Promise<T>;

  /** How long a loaded value is served without a reload. */
  readonly maxAgeMs: number;

  /** After a failed load, the next one waits this long. Default 0. */
  readonly retryAfterFailureMs?: number;

  /** Loads start at most this often, whether they succeed or not. Default 0. */
  readonly minIntervalMs?: number;

  /** Supplies `now` when a call passes none. Default: the wall clock. */
  readonly clock?: Clock;

  /** Called with each newly loaded value. */
  readonly onRefresh?: (value: T) => void;

  /** The error when a load is held back and there is no value to serve. */
  readonly coolingDownError?: () => Error;
}

/**
 * A single value loaded on first use and reloaded when older than `maxAgeMs`. Concurrent callers share one load;
 * a failed load keeps serving the last good value, and loads are held back by `retryAfterFailureMs` after a
 * failure and by `minIntervalMs` after any attempt. Times are numbers of milliseconds.
 */
export class RefreshingCache<T> {
  private current: { readonly value: T; readonly fetchedAt: number } | undefined;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private failedAt: number | undefined;
  private inflight: Promise<T> | undefined;

  constructor(private readonly options: RefreshingCacheOptions<T>) {}

  /** The last good value, however old. */
  get value(): T | undefined {
    return this.current?.value;
  }

  /** When the last good value was loaded. */
  get fetchedAt(): number | undefined {
    return this.current?.fetchedAt;
  }

  /** The value, reloaded first when it is missing or older than `maxAgeMs`. */
  async get(now?: number): Promise<T> {
    const at = this.at(now);
    if (this.current !== undefined && at < this.current.fetchedAt + this.options.maxAgeMs) return this.current.value;
    return this.load(at);
  }

  /** Reloads regardless of age. A load in flight is joined; while loads are held back, the last good value is served. */
  async refresh(now?: number): Promise<T> {
    return this.load(this.at(now));
  }

  private load(now: number): Promise<T> {
    if (this.inflight !== undefined) return this.inflight;
    const minInterval = this.options.minIntervalMs ?? 0;
    const retryAfterFailure = this.options.retryAfterFailureMs ?? 0;
    if (now < this.attemptedAt + minInterval || (this.failedAt !== undefined && now < this.failedAt + retryAfterFailure)) {
      if (this.current !== undefined) return Promise.resolve(this.current.value);
      return Promise.reject(this.options.coolingDownError?.() ?? new Error('RefreshingCache: the last load failed recently'));
    }
    this.attemptedAt = now;
    let started: Promise<T>;
    try {
      started = Promise.resolve(this.options.load(now));
    } catch (err) {
      started = Promise.reject(err);
    }
    const mine: Promise<T> = started.then(
      (value) => {
        if (this.inflight === mine) this.inflight = undefined;
        this.current = { value, fetchedAt: now };
        this.failedAt = undefined;
        this.options.onRefresh?.(value);
        return value;
      },
      (err: unknown) => {
        if (this.inflight === mine) this.inflight = undefined;
        this.failedAt = now;
        if (this.current !== undefined) return this.current.value;
        throw err;
      },
    );
    this.inflight = mine;
    return mine;
  }

  private at(now: number | undefined): number {
    const at = now ?? (this.options.clock ? this.options.clock.now().getTime() : Date.now());
    if (!Number.isFinite(at)) throw new InvalidArgument(`RefreshingCache needs a finite time, got ${String(at)}`, 'now');
    return at;
  }
}
