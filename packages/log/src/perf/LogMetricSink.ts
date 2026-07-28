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

  @Config("logger.perf.sqlMaxLength", { defaultValue: 2000 })
  protected SqlMaxLength!: number;

  /**
   * Emit a log entry for spans that came in UNDER their threshold.
   *
   *  - `false` ( default ) never; a bare `orm.query: 15.2ms` says nothing actionable
   *    and a single request produces hundreds of them,
   *  - `true` for every metric,
   *  - a list of metric names to trace just those, eg. `['orm.query']` for a full db
   *    query trace without dragging in `email.send` and `template.*`, which share
   *    this same logger.
   *
   * Over-threshold and failed spans are always logged regardless of this setting,
   * and the measurements themselves are never affected - they still reach every
   * other sink and the per-request rollup. This only controls per-span log lines.
   */
  @Config("logger.perf.logUnderThreshold", { defaultValue: false })
  protected LogUnderThreshold!: boolean | string[];

  private logsUnderThreshold(name: string): boolean {
    const setting = this.LogUnderThreshold ?? false;
    return Array.isArray(setting) ? setting.includes(name) : setting === true;
  }

  private thresholdFor(name: string): number {
    const t = this.Thresholds ?? {};
    return t[name] ?? t.default ?? 0;
  }

  /**
   * Renders the statement into the message. The `sql` field is already attached to
   * the entry, but most console layouts print only `${message}`, so
   * "Slow orm.query: 251.1ms" on its own gives no way to tell WHICH query it was.
   *
   * Bindings are deliberately left out of the message - they routinely hold
   * passwords, tokens and personal data. They stay in the structured fields, where a
   * target can opt into them.
   */
  private sqlSuffix(fields: Record<string, unknown>): string {
    const sql = fields.sql;

    if (typeof sql !== "string" || sql.trim().length === 0) {
      return "";
    }

    const flattened = sql.replace(/\s+/g, " ").trim();
    const max = this.SqlMaxLength ?? 2000;
    const clipped = flattened.length > max ? `${flattened.slice(0, max)}...` : flattened;

    return ` - ${clipped}`;
  }

  public collect(metric: IPerfMetric): void {
    if (!this.Enabled) return;

    if (metric.kind === "span") {
      const dur = metric.durationMs ?? 0;
      // `metric.fields` already carries `error` for a failed span ( set by the
      // facade ), so the log's error serializer runs when this object is logged.
      const fields = { durationMs: dur, ...(metric.labels ?? {}), ...(metric.fields ?? {}) };

      if (metric.error !== undefined) {
        this.emitAt("error", `${metric.name} failed after ${dur.toFixed(1)}ms${this.sqlSuffix(fields)}`, fields);
        return;
      }

      const threshold = this.thresholdFor(metric.name);
      const slow = threshold > 0 && dur >= threshold;

      if (!slow && !this.logsUnderThreshold(metric.name)) {
        return;
      }

      const level = slow ? this.OverLevel : this.UnderLevel;
      this.emitAt(level, `${slow ? "Slow " : ""}${metric.name}: ${dur.toFixed(1)}ms${this.sqlSuffix(fields)}`, fields);
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
