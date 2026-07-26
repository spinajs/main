import { Singleton, Injectable } from "@spinajs/di";
import { Config } from "@spinajs/configuration";
import { Logger, Log, PerfSink, IPerfMetric, IPerfRollup } from "@spinajs/log-common";

/**
 * Default {@link PerfSink}: renders perf measurements as structured log entries
 * through the normal targets/filters/rules pipeline, on a dedicated `perf`
 * logger. Spans over their per-name threshold log at `warn`; under-threshold
 * spans log at `trace` ( kept for on-demand visibility, cheaply gated out when
 * trace routing is off ). Rollups log one `info` line.
 */
@Singleton()
@Injectable(PerfSink)
export class LogMetricSink extends PerfSink {
  @Logger("perf")
  protected Log!: Log;

  @Config("logger.perf.enabled", { defaultValue: true })
  protected Enabled!: boolean;

  @Config("logger.perf.thresholds", { defaultValue: { "orm.query": 200, "http.request": 1000, default: 0 } })
  protected Thresholds!: Record<string, number>;

  @Config("logger.perf.overThresholdLevel", { defaultValue: "warn" })
  protected OverLevel!: "warn" | "error" | "info" | "debug" | "trace";

  @Config("logger.perf.underThresholdLevel", { defaultValue: "trace" })
  protected UnderLevel!: "warn" | "error" | "info" | "debug" | "trace";

  @Config("logger.perf.logCounters", { defaultValue: false })
  protected LogCounters!: boolean;

  private thresholdFor(name: string): number {
    const t = this.Thresholds ?? {};
    return t[name] ?? t.default ?? 0;
  }

  public collect(metric: IPerfMetric): void {
    if (!this.Enabled) return;

    if (metric.kind === "span") {
      const dur = metric.durationMs ?? 0;
      // `metric.fields` already carries `error` for a failed span ( set by the
      // facade ), so the log's error serializer runs when this object is logged.
      const fields = { durationMs: dur, ...(metric.labels ?? {}), ...(metric.fields ?? {}) };

      if (metric.error !== undefined) {
        this.emitAt("error", `${metric.name} failed after ${dur.toFixed(1)}ms`, fields);
        return;
      }

      const threshold = this.thresholdFor(metric.name);
      const slow = threshold > 0 && dur >= threshold;
      const level = slow ? this.OverLevel : this.UnderLevel;
      this.emitAt(level, `${slow ? "Slow " : ""}${metric.name}: ${dur.toFixed(1)}ms`, fields);
      return;
    }

    if (this.LogCounters && (metric.kind === "counter" || metric.kind === "value")) {
      this.emitAt("trace", `${metric.name}=${metric.value}`, { ...(metric.labels ?? {}) });
    }
  }

  public onScopeEnd(rollup: IPerfRollup): void {
    if (!this.Enabled) return;
    const parts = Object.entries(rollup.byName)
      .map(([n, e]) => `${n} x${e.count} ${e.totalMs.toFixed(0)}ms`)
      .join(", ");
    const tag = rollup.requestId ? ` [${rollup.requestId}]` : "";
    this.emitAt("info", `perf rollup${tag}: ${parts || "no measurements"}`, {
      requestId: rollup.requestId,
      totalMs: rollup.totalMs,
      byName: rollup.byName,
      ...(rollup.labels ?? {}),
    });
  }

  /**
   * Emit through the log's MERGING-OBJECT form ( fields object FIRST, then the
   * message string ) so the structured variables ( durationMs, labels, sql,
   * error ) are attached to the entry. The `@spinajs/log` API treats a trailing
   * object as a printf argument, so passing fields last would silently drop
   * them. See the `warn(fields, message?)` overload on the `Log` base class.
   */
  private emitAt(level: string, message: string, fields: Record<string, unknown>): void {
    switch (level) {
      case "error":
        this.Log.error(fields, message);
        break;
      case "warn":
        this.Log.warn(fields, message);
        break;
      case "info":
        this.Log.info(fields, message);
        break;
      case "debug":
        this.Log.debug(fields, message);
        break;
      default:
        this.Log.trace(fields, message);
        break;
    }
  }
}
