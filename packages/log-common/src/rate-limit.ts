import { consoleLog, type LogWriter, type LogWriterLevel } from "./optional.js";

/** A writer, or a getter resolving one on each write; when the getter returns undefined or throws, the line goes to the console. */
export type LogSource = LogWriter | (() => LogWriter | undefined);

/** The call forms of a {@link Log} level method. */
export type LogArgs = [message: string, ...args: unknown[]] | [err: Error, message: string, ...args: unknown[]] | [fields: object, message?: string, ...args: unknown[]];

export interface RateLimitedLogOptions {
  /** At most one line per key in this many ms. Default 60 000; `Infinity` writes each key once. */
  intervalMs?: number;

  /** Keys remembered at most; past it the key written longest ago is forgotten. Default 256. */
  maxKeys?: number;

  /** Lines across all keys per interval. Default unlimited. */
  maxPerInterval?: number;

  now?: () => number;
}

interface Seen {
  at: number;
  suppressed: number;
}

class KeyGate {
  private readonly seen = new Map<string, Seen>();
  private windowStart = 0;
  private written = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly maxKeys: number,
    private readonly maxPerInterval: number,
    private readonly now: () => number,
  ) {}

  /** Undefined when the line is suppressed, else how many lines of the key were suppressed since it last passed. */
  public pass(key: string): number | undefined {
    const now = this.now();
    const seen = this.seen.get(key);
    if (seen !== undefined && now - seen.at < this.intervalMs) {
      seen.suppressed++;
      return undefined;
    }
    if (this.maxPerInterval !== Infinity) {
      if (now - this.windowStart >= this.intervalMs) {
        this.windowStart = now;
        this.written = 0;
      }
      if (this.written >= this.maxPerInterval) {
        if (seen !== undefined) seen.suppressed++;
        return undefined;
      }
      this.written++;
    }
    // Re-inserted so the map's order stays oldest write first.
    this.seen.delete(key);
    if (this.seen.size >= this.maxKeys) {
      this.seen.delete(this.seen.keys().next().value as string);
    }
    this.seen.set(key, { at: now, suppressed: 0 });
    return seen?.suppressed ?? 0;
  }

  public reset(): void {
    this.seen.clear();
    this.windowStart = 0;
    this.written = 0;
  }
}

function withSuppressed(args: LogArgs, suppressed: number): unknown[] {
  if (suppressed === 0) {
    return args;
  }
  const note = ` (${suppressed} more suppressed)`;
  const [first, second, ...rest] = args as unknown[];
  if (typeof first === "string") {
    return [first + note, ...args.slice(1)];
  }
  const head = first instanceof Error || typeof first !== "object" || first === null ? first : { ...first, suppressed };
  return typeof second === "string" ? [head, second + note, ...rest] : [head, ...args.slice(1)];
}

function emit(source: LogSource, level: LogWriterLevel, args: unknown[]): void {
  try {
    const log = typeof source === "function" ? source() : source;
    if (log !== undefined) {
      (log[level] as (...a: unknown[]) => void).apply(log, args);
      return;
    }
  } catch {
    // fall through to the console
  }
  (consoleLog[level] as (...a: unknown[]) => void)(...args);
}

/**
 * Writes at most one line per key per interval, so input that varies cannot turn into a line per request. A line that
 * follows suppressed ones of its key says how many were dropped, and a fields-form call also gets a `suppressed` field.
 */
export class RateLimitedLog {
  private readonly gate: KeyGate;

  constructor(
    private readonly log: LogSource,
    options: RateLimitedLogOptions = {},
  ) {
    this.gate = new KeyGate(options.intervalMs ?? 60_000, options.maxKeys ?? 256, options.maxPerInterval ?? Infinity, options.now ?? Date.now);
  }

  /** Returns whether the line was written. */
  public write(level: LogWriterLevel, key: string, ...args: LogArgs): boolean {
    const suppressed = this.gate.pass(key);
    if (suppressed === undefined) {
      return false;
    }
    emit(this.log, level, withSuppressed(args, suppressed));
    return true;
  }

  public error(key: string, ...args: LogArgs): boolean {
    return this.write("error", key, ...args);
  }

  public warn(key: string, ...args: LogArgs): boolean {
    return this.write("warn", key, ...args);
  }

  public info(key: string, ...args: LogArgs): boolean {
    return this.write("info", key, ...args);
  }

  public debug(key: string, ...args: LogArgs): boolean {
    return this.write("debug", key, ...args);
  }

  /** Forgets every key and the interval count. */
  public reset(): void {
    this.gate.reset();
  }
}

const once = new KeyGate(Infinity, 1024, Infinity, () => 0);

/**
 * Writes the warning only the first time this process sees `key`; returns whether it wrote. Keys are shared by every
 * caller, so prefix them with the package name. Up to 1024 keys are remembered.
 */
export function warnOnce(log: LogSource, key: string, ...args: LogArgs): boolean {
  if (once.pass(key) === undefined) {
    return false;
  }
  emit(log, "warn", args);
  return true;
}

/** Forgets the keys {@link warnOnce} has seen, for tests. */
export function resetWarnOnce(): void {
  once.reset();
}
