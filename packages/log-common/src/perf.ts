import { DI, SyncService } from "@spinajs/di";

/** Kind of a single measurement. */
export type PerfKind = "span" | "counter" | "value";

/** One unit of instrumentation, emitted to every registered {@link PerfSink}. */
export interface IPerfMetric {
  name: string;
  kind: PerfKind;
  /** span duration in ms ( monotonic ). */
  durationMs?: number;
  /** counter delta / recorded value. */
  value?: number;
  /** LOW-cardinality dimensions ( safe as prom labels ). */
  labels?: Record<string, string | number | boolean>;
  /** rich payload for logs only ( sql text, bindings, rows ). Never a prom label. */
  fields?: Record<string, unknown>;
  /** epoch ms when the measurement started. */
  startedAt?: number;
  /** correlation id from the active request scope, when any. */
  requestId?: string;
  /** set when the measured block threw. */
  error?: unknown;
}

/** Per-name aggregate inside a {@link IPerfRollup}. */
export interface IPerfRollupEntry {
  count: number;
  totalMs: number;
  maxMs: number;
}

/** One per-request summary, handed to {@link PerfSink.onScopeEnd}. */
export interface IPerfRollup {
  requestId?: string;
  labels?: Record<string, string | number | boolean>;
  totalMs: number;
  byName: Record<string, IPerfRollupEntry>;
}

/** The mutable accumulator kept on the async request store. */
export interface IPerfScope {
  requestId?: string;
  byName: Record<string, IPerfRollupEntry>;
}

/**
 * A receiver of perf measurements. Register a concrete subclass with
 * `@Injectable(PerfSink)` and it is discovered via `Array.ofType(PerfSink)`.
 * `SyncService` ( same base as LogTarget ) so resolution stays synchronous.
 */
export abstract class PerfSink extends SyncService {
  /** Receive one measurement. MUST NOT throw ( the facade guards it ). */
  public abstract collect(metric: IPerfMetric): void;
  /** Optional: receive the per-request rollup at scope end. */
  public onScopeEnd?(rollup: IPerfRollup): void;
}

/** Options accepted by {@link Perf.measure} / {@link Perf.start}. */
export interface IMeasureOpts {
  labels?: Record<string, string | number | boolean>;
  fields?: Record<string, unknown>;
}

/** Handle returned by {@link Perf.start}. */
export interface IPerfSpan {
  end(fields?: Record<string, unknown>): void;
}

/**
 * Seam for the per-request scope. The node `@spinajs/log` package wires this to
 * its AsyncLocalStorage-backed LogContext; the default returns `null` so the
 * facade works ( sans rollups ) with no host — eg. on the browser.
 */
export interface IPerfScopeBackend {
  get(): IPerfScope | null;
}

const NOOP_BACKEND: IPerfScopeBackend = { get: () => null };
let perfScopeBackend: IPerfScopeBackend = NOOP_BACKEND;

/** Install the per-request scope backend. See {@link IPerfScopeBackend}. */
export function setPerfScopeBackend(backend: IPerfScopeBackend): void {
  perfScopeBackend = backend ?? NOOP_BACKEND;
}

class PerfImpl {
  /** Global kill-switch; when false measure/start/count/value are pass-throughs. */
  public Enabled = true;

  private sinks: PerfSink[] | null = null;

  /** Drop the memoized sink list so the next emit re-resolves ( tests / late registration ). */
  public refreshSinks(): void {
    this.sinks = null;
  }

  private resolveSinks(): PerfSink[] {
    if (this.sinks === null) {
      // PerfSink extends SyncService => resolve returns synchronously.
      this.sinks = (DI.resolve(Array.ofType(PerfSink)) as PerfSink[]) ?? [];
    }
    return this.sinks;
  }

  private emit(metric: IPerfMetric): void {
    for (const s of this.resolveSinks()) {
      try {
        s.collect(metric);
      } catch {
        /* a sink must never break the measured code or sibling sinks */
      }
    }
  }

  private accumulate(name: string, durationMs: number, scope: IPerfScope | null): void {
    if (!scope) return;
    const e = scope.byName[name] ?? (scope.byName[name] = { count: 0, totalMs: 0, maxMs: 0 });
    e.count += 1;
    e.totalMs += durationMs;
    if (durationMs > e.maxMs) e.maxMs = durationMs;
  }

  private record(name: string, startedAt: number, durationMs: number, opts: IMeasureOpts | undefined, error: unknown): void {
    const scope = perfScopeBackend.get();
    this.accumulate(name, durationMs, scope);
    this.emit({
      name,
      kind: "span",
      durationMs,
      labels: opts?.labels,
      fields: error !== undefined ? { ...(opts?.fields ?? {}), error } : opts?.fields,
      startedAt,
      requestId: scope?.requestId,
      error,
    });
  }

  /**
   * Time `fn` ( sync or async ), emit a span, and return `fn`'s result. On a
   * thrown error the span is still emitted ( with `error` set ) and the error is
   * rethrown.
   */
  public measure<T>(name: string, fn: () => Promise<T> | T, opts?: IMeasureOpts): Promise<T> | T {
    if (!this.Enabled) return fn();
    const startedAt = Date.now();
    const t0 = performance.now();
    let out: Promise<T> | T;
    try {
      out = fn();
    } catch (err) {
      this.record(name, startedAt, performance.now() - t0, opts, err);
      throw err;
    }
    if (out !== null && typeof (out as { then?: unknown })?.then === "function") {
      return (out as Promise<T>).then(
        (v) => {
          this.record(name, startedAt, performance.now() - t0, opts, undefined);
          return v;
        },
        (err) => {
          this.record(name, startedAt, performance.now() - t0, opts, err);
          throw err;
        }
      );
    }
    this.record(name, startedAt, performance.now() - t0, opts, undefined);
    return out;
  }

  /** Open a manual span; call `end()` where timing stops ( start/end may be far apart ). */
  public start(name: string, opts?: IMeasureOpts): IPerfSpan {
    const startedAt = Date.now();
    const t0 = performance.now();
    let ended = false;
    return {
      end: (fields?: Record<string, unknown>) => {
        if (ended) return;
        ended = true;
        const merged: IMeasureOpts = fields ? { labels: opts?.labels, fields: { ...(opts?.fields ?? {}), ...fields } } : opts ?? {};
        this.record(name, startedAt, performance.now() - t0, merged, undefined);
      },
    };
  }

  /** Increment a per-request counter ( eg. query count ) and emit a counter metric. */
  public count(name: string, delta = 1, labels?: Record<string, string | number | boolean>): void {
    if (!this.Enabled) return;
    const scope = perfScopeBackend.get();
    if (scope) {
      const e = scope.byName[name] ?? (scope.byName[name] = { count: 0, totalMs: 0, maxMs: 0 });
      e.count += delta;
    }
    this.emit({ name, kind: "counter", value: delta, labels, requestId: scope?.requestId });
  }

  /** Record an absolute value ( gauge-like ) and emit a value metric. */
  public value(name: string, n: number, labels?: Record<string, string | number | boolean>): void {
    if (!this.Enabled) return;
    const scope = perfScopeBackend.get();
    this.emit({ name, kind: "value", value: n, labels, requestId: scope?.requestId });
  }

  /**
   * Emit the per-request rollup for `scope` to every sink's `onScopeEnd`. The
   * caller ( http ) passes the scope it read off `req.storage`; `extra` carries
   * request labels and total wall time. No-op when `scope` is null.
   */
  public flushScope(scope: IPerfScope | null | undefined, extra?: { labels?: Record<string, string | number | boolean>; totalMs?: number }): void {
    if (!scope) return;
    const rollup: IPerfRollup = {
      requestId: scope.requestId,
      labels: extra?.labels,
      totalMs: extra?.totalMs ?? 0,
      byName: scope.byName,
    };
    for (const sink of this.resolveSinks()) {
      try {
        sink.onScopeEnd?.(rollup);
      } catch {
        /* isolate */
      }
    }
  }
}

/**
 * Shared perf-instrumentation facade. Emits measurements to every registered
 * {@link PerfSink}. See the plan / design doc for usage.
 */
export const Perf = new PerfImpl();
