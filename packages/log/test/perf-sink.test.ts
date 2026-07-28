import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { Log, LogLevel, LogTarget, ICommonTargetOptions, ILogEntry, Perf, PerfSink, LogMetricSink } from "@spinajs/log";

const captured: ILogEntry[] = [];

class CaptureTarget extends LogTarget<ICommonTargetOptions> {
  public write(entry: ILogEntry): void {
    captured.push(entry);
  }
}

class PerfTestConfig extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = {
      logger: {
        targets: [{ name: "cap", type: "CaptureTarget" }],
        rules: [{ name: "*", level: "trace", target: "cap" }],
        perf: {
          enabled: true,
          thresholds: { "orm.query": 100, default: 0 },
          overThresholdLevel: "warn",
          underThresholdLevel: "trace",
          logCounters: true,
        },
      },
    } as any;
  }
}

describe("LogMetricSink", () => {
  let sink: LogMetricSink;

  beforeEach(async () => {
    DI.clearCache();
    (Log as any).Loggers.clear(); // avoid a stale cached 'perf' logger from another test
    captured.length = 0;
    DI.register(CaptureTarget).as("CaptureTarget");
    DI.register(PerfTestConfig).as(Configuration);
    await DI.resolve(Configuration);
    sink = (DI.resolve(Array.ofType(PerfSink)) as PerfSink[]).find((s) => s instanceof LogMetricSink) as LogMetricSink;
  });

  afterEach(() => {
    DI.clearCache();
  });

  it("logs an over-threshold span at warn", () => {
    sink.collect({ name: "orm.query", kind: "span", durationMs: 512, fields: { sql: "SELECT 1" } });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Warn);
    expect(String(captured[0].Variables.message)).to.match(/Slow orm\.query/);
  });

  it("includes the sql in the message of a slow span", () => {
    // a bare "Slow orm.query: 251ms" is unactionable - the whole point of the warning
    // is knowing WHICH query was slow, and console layouts render only the message
    sink.collect({ name: "orm.query", kind: "span", durationMs: 512, fields: { sql: "SELECT * FROM users WHERE id = ?" } });
    expect(String(captured[0].Variables.message)).to.contain("SELECT * FROM users WHERE id = ?");
  });

  it("includes the sql in the message of a failed span", () => {
    sink.collect({ name: "orm.query", kind: "span", durationMs: 5, error: new Error("boom"), fields: { sql: "DELETE FROM sessions" } });
    expect(String(captured[0].Variables.message)).to.contain("DELETE FROM sessions");
  });

  it("collapses whitespace and truncates very long sql", () => {
    const sql = `SELECT\n   ${'x'.repeat(5000)}`;
    sink.collect({ name: "orm.query", kind: "span", durationMs: 512, fields: { sql } });
    const message = String(captured[0].Variables.message);
    expect(message).to.contain("SELECT x");
    expect(message).to.not.contain("\n");
    expect(message.length).to.be.lessThan(3000);
  });

  it("never puts bindings in the message", () => {
    sink.collect({ name: "orm.query", kind: "span", durationMs: 512, fields: { sql: "SELECT 1 WHERE pass = ?", bindings: ['sup3rs3cret'] } });
    expect(String(captured[0].Variables.message)).to.not.contain("sup3rs3cret");
  });

  /**
   * `@Config` is a live getter reading DI's current Configuration, so overriding a
   * perf setting is just a `set()` on it - no need to swap the config class, which
   * does not reliably replace the already-resolved singleton.
   */
  function withPerf(perf: Record<string, unknown>): LogMetricSink {
    const cfg = DI.get(Configuration)!;
    for (const [k, v] of Object.entries(perf)) {
      cfg.set(`logger.perf.${k}`, v);
    }
    captured.length = 0;
    return sink;
  }

  it("does not log an under-threshold span by default", () => {
    // a bare "orm.query: 3.0ms" is pure noise - hundreds per request, nothing actionable
    sink.collect({ name: "orm.query", kind: "span", durationMs: 3 });
    expect(captured).to.have.length(0);
  });

  it("logs an under-threshold span at trace when logUnderThreshold is on", () => {
    const s = withPerf({ logUnderThreshold: true });
    s.collect({ name: "orm.query", kind: "span", durationMs: 3, fields: { sql: "SELECT id FROM campaigns" } });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Trace);
    expect(String(captured[0].Variables.message)).to.contain("SELECT id FROM campaigns");
  });

  it("logs under-threshold spans only for the named metrics when given a list", () => {
    // the perf logger is shared by orm.query, email.send and template.* - a full db
    // query trace should not drag every other measurement along with it
    const s = withPerf({ logUnderThreshold: ["orm.query"] });

    s.collect({ name: "orm.query", kind: "span", durationMs: 3, fields: { sql: "SELECT 1" } });
    s.collect({ name: "template.render", kind: "span", durationMs: 3 });
    s.collect({ name: "email.send", kind: "span", durationMs: 3 });

    expect(captured).to.have.length(1);
    expect(String(captured[0].Variables.message)).to.contain("orm.query");
  });

  it("still logs OVER-threshold spans for metrics absent from the list", () => {
    const s = withPerf({ logUnderThreshold: ["orm.query"], thresholds: { "template.render": 10, default: 0 } });
    s.collect({ name: "template.render", kind: "span", durationMs: 50 });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Warn);
  });

  it("logs a rollup summary at info via onScopeEnd", () => {
    sink.onScopeEnd({ requestId: "r1", totalMs: 42, byName: { "orm.query": { count: 4, totalMs: 20, maxMs: 8 } } });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Info);
    expect(String(captured[0].Variables.message)).to.match(/orm\.query x4/);
  });

  it("is registered as a PerfSink and discovered by Perf", () => {
    Perf.refreshSinks();
    const sinks = DI.resolve(Array.ofType(PerfSink)) as PerfSink[];
    expect(sinks.some((s) => s instanceof LogMetricSink)).to.eq(true);
  });

  it("logs a counter metric at trace when logCounters is enabled", () => {
    sink.collect({ name: "cache.size", kind: "counter", value: 2 });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Trace);
    expect(String(captured[0].Variables.message)).to.match(/cache\.size=2/);
  });

  it("logs a failed span at error", () => {
    sink.collect({ name: "orm.query", kind: "span", durationMs: 5, error: new Error("boom"), fields: { error: new Error("boom") } });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Error);
    expect(String(captured[0].Variables.message)).to.match(/orm\.query failed/);
  });
});
