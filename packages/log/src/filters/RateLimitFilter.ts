import { ILogEntry, ILogFilterOptions, LogFilter } from "@spinajs/log-common";
import { Injectable } from "@spinajs/di";

/**
 * Options for {@link RateLimitFilter}.
 */
export interface IRateLimitFilterOptions extends ILogFilterOptions {
  /** Max entries kept per window. Required. */
  limit: number;
  /** Fixed window length in SECONDS. Required. */
  intervalSeconds: number;
  /** Variable field used to bucket the limit ( eg. per-logger ). Global if unset. */
  key?: string;
}

interface IWindowRecord {
  count: number;
  windowStart: number;
}

const GLOBAL_KEY = "__global__";

/**
 * Fixed-window rate limiter. Keeps at most `limit` entries per `intervalSeconds`
 * window, bucketed by `entry.Variables[key]` when `key` is given ( else a single
 * global bucket ). Overflow entries within a window are DROPPED; the counter
 * resets when the window elapses. The bucket map is self-pruning ( stale windows
 * dropped on access ) so memory stays bounded. Clock is injectable for tests.
 */
@Injectable("RateLimitFilter")
export class RateLimitFilter extends LogFilter {
  protected limit: number;
  protected intervalMs: number;
  protected keyField?: string;
  protected windows: Map<string, IWindowRecord> = new Map();

  constructor(options?: IRateLimitFilterOptions, protected now: () => number = () => Date.now()) {
    super(options);
    this.limit = options?.limit ?? 0;
    this.intervalMs = (options?.intervalSeconds ?? 0) * 1000;
    this.keyField = options?.key;
  }

  protected keyOf(entry: ILogEntry): string {
    if (!this.keyField) {
      return GLOBAL_KEY;
    }
    return String(entry.Variables[this.keyField]);
  }

  public apply(entry: ILogEntry): ILogEntry | null {
    const now = this.now();
    const key = this.keyOf(entry);
    const record = this.windows.get(key);

    if (!record || now - record.windowStart >= this.intervalMs) {
      // fresh window - start counting from this entry
      this.windows.set(key, { count: 1, windowStart: now });
      this.prune(now);
      return entry;
    }

    if (record.count < this.limit) {
      record.count++;
      return entry;
    }

    // window full - drop
    return null;
  }

  /** Drops windows whose interval has fully elapsed so the map stays bounded. */
  protected prune(now: number): void {
    for (const [k, r] of this.windows) {
      if (now - r.windowStart >= this.intervalMs) {
        this.windows.delete(k);
      }
    }
  }
}
