import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { Log, LogLevel, LogTarget, ICommonTargetOptions, ILogEntry, Perf, PerfSink } from "@spinajs/log";
import { LogMetricSink } from "../src/perf/LogMetricSink.js";

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

  it("logs an under-threshold span at trace", () => {
    sink.collect({ name: "orm.query", kind: "span", durationMs: 3 });
    expect(captured).to.have.length(1);
    expect(captured[0].Level).to.eq(LogLevel.Trace);
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
});
