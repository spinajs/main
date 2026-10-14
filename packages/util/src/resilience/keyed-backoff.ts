import { InvalidArgument } from '@spinajs/exceptions';

export interface BackoffParams {
  readonly free: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** The wait after counted attempt n (1-based): 0 until n reaches free, then min(baseDelayMs × 2^(n − free), maxDelayMs). */
export function backoffDelayMs(p: BackoffParams, n: number): number {
  return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free), p.maxDelayMs);
}

export interface KeyedBackoffGate {
  readonly key: string;
  /** Trusted: the caller validates it. */
  readonly backoff: BackoffParams;
}

export type KeyedBackoffVerdict = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface KeyedBackoffRow {
  attempts: number;
  /** Stamped from a per-table counter when the row is created: a decayed or evicted key starts a new run. */
  readonly run: number;
  /** The gate's `free`; Infinity for a counted key that gates nothing. Decides the eviction tier. */
  readonly free: number;
  lastMs: number;
  /** 0 when the key does not delay. */
  nextMs: number;
}

export interface KeyedBackoffOptions {
  /** Integer >= 1. */
  readonly maxRows: number;
  /** > 0. A row with no counted attempt this long, and no running delay, expires. */
  readonly resetAfterMs: number;
  /** Expired rows checked per attempt. Default 8, more than the rows one attempt can add, so each pass reaches the end. */
  readonly sweepBatch?: number;
  /** Retry-After when a full table has no delaying row to wait for. Default 60,000. */
  readonly fullRetryMs?: number;
  /** Pause before the next scan while the table stays nearly full. Default 1000. */
  readonly holdOffMs?: number;
  /** Default `backoffDelayMs`; a test seam. */
  readonly delay?: (p: BackoffParams, n: number) => number;
  /** Called once per full episode; a throw is swallowed and the call retried on the next scan. */
  readonly onFull?: () => void;
}

const refused = (waitMs: number): KeyedBackoffVerdict => ({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) });

const requireInteger = (name: string, v: unknown, min: number): number => {
  if (!Number.isInteger(v) || (v as number) < min) throw new InvalidArgument(`KeyedBackoff: ${name} must be an integer >= ${min}`);
  return v as number;
};

const requireNumber = (name: string, v: unknown, min: number, inclusive: boolean): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || (inclusive ? v < min : v <= min)) {
    throw new InvalidArgument(`KeyedBackoff: ${name} must be a finite number ${inclusive ? '>=' : '>'} ${min}`);
  }
  return v;
};

const requireNow = (nowMs: unknown): number => {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new InvalidArgument('KeyedBackoff: nowMs must be a finite number');
  return nowMs;
};

/**
 * Per-key exponential backoff kept in memory, for a single process. It never locks a key: a key only waits longer.
 * Keys are opaque strings; the caller hashes them.
 *
 * `attempt` checks every gating key and claims the slot with no `await` in between, so parallel attempts are atomic.
 *
 * Capacity: at most `maxRows` rows, in last-attempt order. Each attempt sweeps a few expired rows. When the table is
 * full, rows that delay nobody at that moment are evicted, oldest last attempt first: first expired rows and rows
 * below their `free`, then rows deeper in backoff, which lose their count. A row that is delaying is never evicted;
 * when no row can go, attempts that need a new row are refused.
 */
export class KeyedBackoff {
  private readonly rows = new Map<string, KeyedBackoffRow>();
  private cursor: Iterator<[string, KeyedBackoffRow]> | undefined;
  /** While full, refuse without a scan until this time. */
  private fullUntilMs = 0;
  private fullReported = false;
  private seq = 0;

  private readonly maxRows: number;
  private readonly resetAfterMs: number;
  private readonly sweepBatch: number;
  private readonly fullRetryMs: number;
  private readonly holdOffMs: number;
  private readonly delay: (p: BackoffParams, n: number) => number;
  private readonly onFull: (() => void) | undefined;

  constructor(options: KeyedBackoffOptions) {
    this.maxRows = requireInteger('maxRows', options.maxRows, 1);
    this.resetAfterMs = requireNumber('resetAfterMs', options.resetAfterMs, 0, false);
    this.sweepBatch = requireInteger('sweepBatch', options.sweepBatch ?? 8, 1);
    this.fullRetryMs = requireNumber('fullRetryMs', options.fullRetryMs ?? 60_000, 0, false);
    this.holdOffMs = requireNumber('holdOffMs', options.holdOffMs ?? 1000, 0, true);
    this.delay = options.delay ?? backoffDelayMs;
    this.onFull = options.onFull;
  }

  get size(): number {
    return this.rows.size;
  }

  /**
   * Refuses with the longest running delay among `gates`; otherwise makes room and counts every gate and every `counted` key.
   * Synchronous: no interleaving.
   */
  attempt(gates: readonly KeyedBackoffGate[], counted: readonly string[], nowMs: number): KeyedBackoffVerdict {
    requireNow(nowMs);
    const gating = new Map<string, BackoffParams>();
    for (const g of gates) if (!gating.has(g.key)) gating.set(g.key, g.backoff);
    const books = new Set<string>();
    for (const key of counted) if (!gating.has(key)) books.add(key);

    this.sweep(nowMs);

    const waitMs = this.waitMs(gating.keys(), nowMs);
    if (waitMs > 0) return refused(waitMs);

    let needed = 0;
    for (const key of gating.keys()) if (!this.live(key, nowMs)) needed++;
    for (const key of books) if (!this.live(key, nowMs)) needed++;
    if (needed > 0 && this.rows.size + needed > this.maxRows) {
      const retryAfterSeconds = this.makeRoom(needed, nowMs);
      if (retryAfterSeconds !== undefined) return { allowed: false, retryAfterSeconds };
    }

    // Gates first: a counted key created in this attempt gets a later run than the gates created with it (authn D8 relies on it).
    for (const [key, p] of gating) this.count(key, nowMs, p);
    for (const key of books) this.count(key, nowMs);
    return { allowed: true };
  }

  /** Like attempt for a delay, counting nothing; a full table does not refuse. */
  peek(gates: readonly KeyedBackoffGate[], nowMs: number): KeyedBackoffVerdict {
    requireNow(nowMs);
    const waitMs = this.waitMs(
      gates.map((g) => g.key),
      nowMs,
    );
    return waitMs > 0 ? refused(waitMs) : { allowed: true };
  }

  /** Sweeps up to `batch` rows (default sweepBatch); a caller with several tables spreads sweeps across them. */
  sweep(nowMs: number, batch: number = this.sweepBatch): void {
    requireNow(nowMs);
    requireInteger('sweep batch', batch, 0);
    for (let i = 0; i < batch; i++) {
      this.cursor ??= this.rows.entries();
      // A Map iterator survives deletes and appends, so each call resumes the pass where the last one stopped.
      const next = this.cursor.next();
      if (next.done) {
        this.cursor = undefined;
        return;
      }
      const [key, row] = next.value;
      if (this.stale(row, nowMs)) this.rows.delete(key);
    }
  }

  /** The live row, or undefined; expires it first when stale. Change a row through `lower` or `delete`. */
  row(key: string, nowMs?: number): Readonly<KeyedBackoffRow> | undefined {
    return nowMs === undefined ? this.rows.get(key) : this.live(key, requireNow(nowMs));
  }

  delete(key: string): boolean {
    return this.rows.delete(key);
  }

  /** Takes `by` attempts off a row and recomputes its delay from its last attempt; at 0 it deletes the row. */
  lower(key: string, by: number, backoff: BackoffParams): void {
    requireInteger('lower by', by, 0);
    const row = this.rows.get(key);
    if (!row) return;
    row.attempts = Math.max(0, row.attempts - by);
    if (row.attempts === 0) {
      this.rows.delete(key);
      return;
    }
    const d = this.delay(backoff, row.attempts);
    row.nextMs = d > 0 ? row.lastMs + d : 0;
  }

  /** Clears the full hold-off (a success frees the table at once). */
  release(): void {
    this.fullUntilMs = 0;
  }

  /** Read-only view, oldest last attempt first (tests, diagnostics). */
  entries(): IterableIterator<[string, Readonly<KeyedBackoffRow>]> {
    return this.rows.entries();
  }

  private waitMs(keys: Iterable<string>, nowMs: number): number {
    let waitMs = 0;
    for (const key of keys) {
      const row = this.live(key, nowMs);
      if (row && row.nextMs > nowMs) waitMs = Math.max(waitMs, row.nextMs - nowMs);
    }
    return waitMs;
  }

  // Idle alone does not expire a row: a delay longer than resetAfterMs still runs to its end.
  private stale(row: KeyedBackoffRow, nowMs: number): boolean {
    return nowMs - row.lastMs >= this.resetAfterMs && row.nextMs <= nowMs;
  }

  private live(key: string, nowMs: number): KeyedBackoffRow | undefined {
    const row = this.rows.get(key);
    if (row && this.stale(row, nowMs)) {
      this.rows.delete(key);
      return undefined;
    }
    return row;
  }

  private count(key: string, nowMs: number, p?: BackoffParams): void {
    const row = this.live(key, nowMs) ?? { attempts: 0, run: ++this.seq, free: p ? p.free : Infinity, lastMs: nowMs, nextMs: 0 };
    row.attempts += 1;
    row.lastMs = Math.max(row.lastMs, nowMs);
    if (p) {
      const d = this.delay(p, row.attempts);
      row.nextMs = d > 0 ? nowMs + d : 0;
    }
    this.rows.delete(key);
    this.rows.set(key, row);
  }

  /** Frees room for `needed` new rows in a full table; returns a Retry-After when it cannot. */
  private makeRoom(needed: number, nowMs: number): number | undefined {
    if (nowMs < this.fullUntilMs) return Math.ceil((this.fullUntilMs - nowMs) / 1000);
    // Slack, so a full table is not scanned on every attempt.
    const target = this.maxRows - Math.max(needed, Math.ceil(this.maxRows / 100));
    this.evict(nowMs, target, (r) => r.attempts < r.free || this.stale(r, nowMs));
    const firstFree = this.evict(nowMs, target, () => true);
    if (this.rows.size + needed <= this.maxRows) {
      this.fullReported = false;
      // Short of the slack, nearly every row delays: hold off the next scan briefly.
      if (this.rows.size > target) this.fullUntilMs = Math.min(firstFree, nowMs + this.holdOffMs);
      return undefined;
    }
    this.fullUntilMs = Number.isFinite(firstFree) ? firstFree : nowMs + this.fullRetryMs;
    if (!this.fullReported && this.onFull) {
      try {
        this.onFull();
        this.fullReported = true;
      } catch {
        // Under a flood the refusal matters more than the notification; it stays due for the next scan.
      }
    }
    return Math.max(1, Math.ceil((this.fullUntilMs - nowMs) / 1000));
  }

  /** Deletes rows that delay nobody and match `tier`, oldest first, down to `target`; returns the earliest end of a delay seen. */
  private evict(nowMs: number, target: number, tier: (r: KeyedBackoffRow) => boolean): number {
    let firstFree = Infinity;
    for (const [key, row] of this.rows) {
      if (this.rows.size <= target) break;
      if (row.nextMs > nowMs) firstFree = Math.min(firstFree, row.nextMs);
      else if (tier(row)) this.rows.delete(key);
    }
    return firstFree;
  }
}
