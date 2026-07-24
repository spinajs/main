import { Singleton, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { PerfSink, IPerfMetric } from '@spinajs/log';

/** One aggregated span row. */
export interface IPerfSpanEntry {
  name: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

/** One aggregated counter / value row. */
export interface IPerfEventEntry {
  name: string;
  count: number;
  total: number;
}

/** Serializable snapshot served by `GET /telemetry/perf`. */
export interface IPerfSnapshot {
  /** True once the name cap was hit and new names stopped being tracked. */
  truncated: boolean;
  spans: IPerfSpanEntry[];
  events: IPerfEventEntry[];
}

/**
 * A {@link PerfSink} that keeps a bounded, JSON-readable aggregate of every
 * measurement, backing `GET /telemetry/perf`.
 *
 * This exists alongside `PromMetricSink` rather than replacing it: prom
 * histograms are the right shape for Prometheus but their bucket counts cannot
 * be read back as a mean or a max, which is what a JSON snapshot needs.
 *
 * Per-request rollups are intentionally NOT implemented here — `onScopeEnd`
 * totals share the span names, so folding them in would double-count against
 * the same rows. The per-request view lives in `perf_scope_total_ms` on the
 * prometheus side.
 */
@Singleton()
@Injectable(PerfSink)
export class InMemoryPerfSink extends PerfSink {
  @Config('telemetry.perf.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  @Config('telemetry.perf.maxNames', { defaultValue: 200 })
  protected MaxNames!: number;

  private spans = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private events = new Map<string, { count: number; total: number }>();
  private truncated = false;

  public collect(metric: IPerfMetric): void {
    if (this.Enabled === false) return;
    if (!metric || typeof metric.name !== 'string') return;

    if (metric.kind === 'span') {
      const entry = this.spans.get(metric.name) ?? (this.track(metric.name) ? this.create(this.spans, metric.name, { count: 0, totalMs: 0, maxMs: 0 }) : undefined);
      if (!entry) return;

      const durationMs = metric.durationMs ?? 0;
      entry.count += 1;
      entry.totalMs += durationMs;
      if (durationMs > entry.maxMs) entry.maxMs = durationMs;
      return;
    }

    const entry = this.events.get(metric.name) ?? (this.track(metric.name) ? this.create(this.events, metric.name, { count: 0, total: 0 }) : undefined);
    if (!entry) return;

    entry.count += 1;
    entry.total += metric.value ?? 1;
  }

  public toJSON(): IPerfSnapshot {
    const spans: IPerfSpanEntry[] = [];
    for (const [name, e] of this.spans) {
      spans.push({ name, count: e.count, totalMs: e.totalMs, avgMs: e.count > 0 ? e.totalMs / e.count : 0, maxMs: e.maxMs });
    }
    spans.sort((a, b) => b.totalMs - a.totalMs);

    const events: IPerfEventEntry[] = [];
    for (const [name, e] of this.events) {
      events.push({ name, count: e.count, total: e.total });
    }
    events.sort((a, b) => b.total - a.total);

    return { truncated: this.truncated, spans, events };
  }

  /**
   * Whether a NEW name may be tracked. Spans and events share one budget so the
   * total retained-name count is what `maxNames` bounds.
   */
  private track(_name: string): boolean {
    if (this.spans.size + this.events.size >= (this.MaxNames ?? 200)) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  private create<T>(map: Map<string, T>, name: string, initial: T): T {
    map.set(name, initial);
    return initial;
  }
}
