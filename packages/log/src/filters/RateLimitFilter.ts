import { ILogEntry, ILogFilterOptions, LogFilter, LogLevel, StrToLogLevel } from "@spinajs/log-common";
import { Injectable, NewInstance } from "@spinajs/di";
import { InvalidOption } from "@spinajs/exceptions";
import GlobToRegExp from "glob-to-regexp";

type LevelName = keyof typeof StrToLogLevel;

/**
 * Options for {@link RateLimitFilter}. `limit` and `intervalSeconds` set the limit; `logger`, `where`, `level` and
 * `maxLevel` choose the entries it applies to (all others pass untouched); `key` splits it into buckets.
 */
export interface IRateLimitFilterOptions extends ILogFilterOptions {
  /** Entries kept per window and bucket. Required, an integer of at least 1. */
  limit: number;

  /** Window length in seconds. Required, above 0. */
  intervalSeconds: number;

  /** Variables the bucket is keyed by, eg. `"logger"` or `["origin", "ownOrigin"]`. One bucket when unset. */
  key?: string | string[];

  /** Logger name globs ( as in rules ) the limit applies to. Every logger when unset. */
  logger?: string | string[];

  /** Variables an entry must equal ( `===` ) for the limit to apply. */
  where?: Record<string, string | number | boolean>;

  /** Lowest level the limit applies to ( inclusive ). Default `trace`. */
  level?: LevelName;

  /** Highest level the limit applies to ( inclusive ). Default `security`. */
  maxLevel?: LevelName;

  /** Buckets kept at most; past it expired ones go first, then the one whose window opened first. Default 1024. */
  maxKeys?: number;

  /** The first entry kept after drops in its bucket gets ` (N suppressed)` and a `suppressed` variable. Default true. */
  reportSuppressed?: boolean;
}

interface IWindowRecord {
  count: number;
  windowStart: number;
  dropped: number;
}

const GLOBAL_KEY = "__global__";

function levelOf(name: LevelName | undefined, fallback: LogLevel, option: string): LogLevel {
  if (name === undefined) {
    return fallback;
  }
  const level = StrToLogLevel[name];
  if (level === undefined) {
    throw new InvalidOption(`RateLimitFilter: invalid ${option} '${name}'`);
  }
  return level;
}

/**
 * Fixed-window rate limiter. Of the entries it applies to, keeps at most `limit` per `intervalSeconds` window and
 * bucket and drops the rest. A window opens with the first entry of its bucket. Clock is injectable for tests.
 */
@Injectable("RateLimitFilter")
@NewInstance()
export class RateLimitFilter extends LogFilter {
  protected limit: number;
  protected intervalMs: number;
  protected keyFields: string[];
  protected loggers: RegExp[];
  protected where: [string, unknown][];
  protected minLevel: LogLevel;
  protected maxLevel: LogLevel;
  protected maxKeys: number;
  protected reportSuppressed: boolean;
  protected windows: Map<string, IWindowRecord> = new Map();

  constructor(options?: IRateLimitFilterOptions, protected now: () => number = () => Date.now()) {
    super(options);
    const limit = options?.limit;
    const interval = options?.intervalSeconds;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      throw new InvalidOption(`RateLimitFilter: limit must be an integer of at least 1, got ${String(limit)}`);
    }
    if (typeof interval !== "number" || !(interval > 0) || !Number.isFinite(interval)) {
      throw new InvalidOption(`RateLimitFilter: intervalSeconds must be a number above 0, got ${String(interval)}`);
    }
    const maxKeys = options?.maxKeys ?? 1024;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new InvalidOption(`RateLimitFilter: maxKeys must be an integer of at least 1, got ${String(maxKeys)}`);
    }

    this.limit = limit;
    this.intervalMs = interval * 1000;
    this.keyFields = options?.key === undefined ? [] : ([] as string[]).concat(options.key);
    this.loggers = options?.logger === undefined ? [] : ([] as string[]).concat(options.logger).map((g) => GlobToRegExp(g));
    this.where = Object.entries(options?.where ?? {});
    this.minLevel = levelOf(options?.level, LogLevel.Trace, "level");
    this.maxLevel = levelOf(options?.maxLevel, LogLevel.Security, "maxLevel");
    this.maxKeys = maxKeys;
    this.reportSuppressed = options?.reportSuppressed ?? true;
  }

  /** Whether the limit applies to the entry; entries it does not apply to always pass. */
  protected applies(entry: ILogEntry): boolean {
    if (entry.Level < this.minLevel || entry.Level > this.maxLevel) {
      return false;
    }
    if (this.loggers.length !== 0) {
      const name = String(entry.Variables.logger);
      if (!this.loggers.some((re) => re.test(name))) {
        return false;
      }
    }
    return this.where.every(([field, value]) => entry.Variables[field] === value);
  }

  protected keyOf(entry: ILogEntry): string {
    if (this.keyFields.length === 0) {
      return GLOBAL_KEY;
    }
    // JSON keeps ["a|b", "c"] and ["a", "b|c"] apart.
    return JSON.stringify(this.keyFields.map((f) => (entry.Variables[f] === undefined ? null : String(entry.Variables[f]))));
  }

  public apply(entry: ILogEntry): ILogEntry | null {
    if (!this.applies(entry)) {
      return entry;
    }

    const now = this.now();
    const key = this.keyOf(entry);
    const record = this.windows.get(key);

    if (!record || now - record.windowStart >= this.intervalMs) {
      if (record) {
        // Re-inserted so the map stays ordered by window start, which prune() relies on.
        this.windows.delete(key);
      } else {
        this.prune(now);
      }
      this.windows.set(key, { count: 1, windowStart: now, dropped: 0 });
      if (record && record.dropped > 0 && this.reportSuppressed) {
        entry.Variables.message = `${entry.Variables.message} (${record.dropped} suppressed)`;
        entry.Variables.suppressed = record.dropped;
      }
      return entry;
    }

    if (record.count < this.limit) {
      record.count++;
      return entry;
    }

    record.dropped++;
    return null;
  }

  /** Makes room for one more bucket: expired windows first, then the oldest. Their unreported counts are lost. */
  protected prune(now: number): void {
    if (this.windows.size < this.maxKeys) {
      return;
    }
    for (const [k, r] of this.windows) {
      if (now - r.windowStart >= this.intervalMs) {
        this.windows.delete(k);
      }
    }
    while (this.windows.size >= this.maxKeys) {
      this.windows.delete(this.windows.keys().next().value as string);
    }
  }
}
