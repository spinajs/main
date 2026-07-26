import { Singleton, Injectable, DI } from "@spinajs/di";
import { PerfSink, IPerfMetric, IPerfRollup } from "@spinajs/log";
import { Counter, Histogram } from "prom-client";
import { Metrics, MetricMap } from "./metrics.js";

/** Duration histogram buckets ( ms ), mirroring the http telemetry middleware. */
export const PERF_DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * {@link PerfSink} that forwards perf measurements to the shared prom-client
 * {@link Metrics} registry — the prom side of the dual-sink. Span durations go
 * to `perf_span_duration_ms{name}`; counter/value events increment
 * `perf_events_total{name}`; per-request scope totals go to their own
 * `perf_scope_total_ms{name}` histogram so they don't conflate with the
 * per-span distribution. Labels are restricted to `name` ( plus the metric's
 * own low-cardinality labels are folded into the name label space via a single
 * `name` label to stay bounded ).
 */
@Singleton()
@Injectable(PerfSink)
export class PromMetricSink extends PerfSink {
  protected metrics!: Metrics;
  protected duration!: Histogram<string>;
  protected events!: Counter<string>;
  protected scopeTotal!: Histogram<string>;
  private defined = false;

  private ensure(): void {
    if (this.defined) return;
    this.metrics = DI.get(Metrics) ?? DI.resolve(Metrics);
    const map: MetricMap = this.metrics.defineMetrics("perf", [
      { name: "span_duration_ms", help: "Perf span duration in ms", type: "histogram", labelNames: ["name"], buckets: PERF_DURATION_BUCKETS_MS },
      { name: "events_total", help: "Perf counter/value events", type: "counter", labelNames: ["name"] },
      { name: "scope_total_ms", help: "Perf per-request scope total duration in ms", type: "histogram", labelNames: ["name"], buckets: PERF_DURATION_BUCKETS_MS },
    ]);
    this.duration = map["span_duration_ms"] as Histogram<string>;
    this.events = map["events_total"] as Counter<string>;
    this.scopeTotal = map["scope_total_ms"] as Histogram<string>;
    this.defined = true;
  }

  public collect(metric: IPerfMetric): void {
    this.ensure();
    if (metric.kind === "span") {
      this.duration.observe({ name: metric.name }, metric.durationMs ?? 0);
    } else {
      this.events.inc({ name: metric.name }, metric.value ?? 1);
    }
  }

  public onScopeEnd(rollup: IPerfRollup): void {
    this.ensure();
    for (const [name, e] of Object.entries(rollup.byName)) {
      // per-request totals: record the aggregate duration once per request, into
      // its own histogram so it doesn't conflate with the per-span distribution.
      if (e.totalMs > 0) this.scopeTotal.observe({ name }, e.totalMs);
    }
  }
}
