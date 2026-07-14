// type-only import - erased at compile time so there is no runtime import cycle
// back to ../index.js. The filter compares `entry.Level` numerically and never
// needs the `LogLevel` enum VALUES, so a type import is sufficient.
import type { ILogEntry } from "../index.js";

export interface IWhenRepeatedOptions {
  /**
   * Suppression window in SECONDS. Identical entries logged within this window
   * ( from the first occurrence ) are collapsed into one. Default is 10.
   */
  timeout?: number;

  /**
   * Hard cap on the number of tracked keys. The internal map is self-pruning:
   * expired records are dropped first, then the oldest, so memory stays bounded
   * even under many distinct messages. Default is 1024.
   */
  maxKeys?: number;
}

interface IRepeatRecord {
  count: number;
  windowStart: number;
  level: number;
}

/**
 * Port of NLog's WhenRepeatedFilter. Collapses identical, repeated log entries
 * within a timeout window into a single emitted entry, appending a ` (xN)`
 * suppressed-count when logging of that key resumes. This stops a hot loop or a
 * flapping error from flooding console / file / Loki and burying real signal.
 *
 * Known tradeoff: there is no background timer. A residual suppressed count is
 * flushed on the NEXT matching entry ( window expired or higher severity ), NOT
 * when the window simply elapses with no further activity. This keeps the filter
 * dependency-free; the full filter pipeline in a later phase can layer a timed
 * flush on top.
 */
export class WhenRepeatedFilter {
  protected timeoutMs: number;
  protected maxKeys: number;
  protected records: Map<string, IRepeatRecord> = new Map();

  constructor(options?: IWhenRepeatedOptions, protected now: () => number = () => Date.now()) {
    this.timeoutMs = (options?.timeout ?? 10) * 1000;
    this.maxKeys = options?.maxKeys ?? 1024;
  }

  protected keyOf(entry: ILogEntry): string {
    return `${entry.Level}|${entry.Variables.logger}|${entry.Variables.message}`;
  }

  /**
   * Returns the entry to EMIT ( possibly with an injected suppressed-count ) or
   * `null` to SUPPRESS.
   */
  public filter(entry: ILogEntry): ILogEntry | null {
    const key = this.keyOf(entry);
    const now = this.now();
    const record = this.records.get(key);

    if (!record) {
      // first occurrence of this key - emit and start tracking
      this.records.set(key, { count: 0, windowStart: now, level: entry.Level });
      this.prune(now);
      return entry;
    }

    if (now - record.windowStart < this.timeoutMs && entry.Level <= record.level) {
      // still inside the window and not a higher severity - suppress
      record.count++;
      return null;
    }

    // window expired OR a higher-severity entry arrived - emit and reset. If we
    // suppressed anything, inject the count into the ( freshly built per call,
    // so safe to mutate ) message string.
    if (record.count > 0) {
      entry.Variables.message = `${entry.Variables.message} (x${record.count})`;
    }

    this.records.set(key, { count: 0, windowStart: now, level: entry.Level });
    this.prune(now);
    return entry;
  }

  /**
   * Keeps the tracked-key map bounded. Drops expired records first, then the
   * oldest by `windowStart` until at/under the cap.
   */
  protected prune(now: number): void {
    if (this.records.size <= this.maxKeys) {
      return;
    }

    for (const [k, r] of this.records) {
      if (now - r.windowStart >= this.timeoutMs) {
        this.records.delete(k);
      }
    }

    if (this.records.size <= this.maxKeys) {
      return;
    }

    const byAge = [...this.records.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
    for (const [k] of byAge) {
      if (this.records.size <= this.maxKeys) {
        break;
      }
      this.records.delete(k);
    }
  }
}
