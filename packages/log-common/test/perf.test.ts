import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Perf, PerfSink, IPerfMetric, IPerfRollup, IPerfScope, setPerfScopeBackend } from "../src/index.js";

// A fake sink that records everything it receives.
class RecordingSink extends PerfSink {
  public metrics: IPerfMetric[] = [];
  public rollups: IPerfRollup[] = [];
  public collect(m: IPerfMetric): void {
    this.metrics.push(m);
  }
  public onScopeEnd(r: IPerfRollup): void {
    this.rollups.push(r);
  }
}

describe("Perf facade", () => {
  let sink: RecordingSink;

  beforeEach(() => {
    DI.clearCache();
    DI.register(RecordingSink).as(PerfSink);
    // resolve so Perf.resolveSinks() memoizes THIS sink
    sink = DI.resolve(Array.ofType(PerfSink))[0] as RecordingSink;
    Perf.Enabled = true;
    Perf.refreshSinks();
    setPerfScopeBackend({ get: () => null }); // no request scope by default
  });

  afterEach(() => {
    setPerfScopeBackend({ get: () => null });
    DI.clearCache();
  });

  it("measure() times an async fn, returns its value, and emits a span", async () => {
    const result = await Perf.measure("job", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    }, { labels: { kind: "x" }, fields: { note: "hi" } });

    expect(result).to.eq(42);
    expect(sink.metrics).to.have.length(1);
    const m = sink.metrics[0];
    expect(m.name).to.eq("job");
    expect(m.kind).to.eq("span");
    expect(m.durationMs).to.be.a("number").and.to.be.greaterThan(0);
    expect(m.labels).to.deep.eq({ kind: "x" });
    expect(m.error).to.eq(undefined);
  });

  it("measure() records a span with error then rethrows on failure", async () => {
    const boom = new Error("boom");
    let thrown: unknown;
    try {
      await Perf.measure("job", async () => {
        throw boom;
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.eq(boom);
    expect(sink.metrics).to.have.length(1);
    expect(sink.metrics[0].error).to.eq(boom);
  });

  it("count() bumps the active scope and emits a counter", () => {
    const scope: IPerfScope = { requestId: "r1", byName: {} };
    setPerfScopeBackend({ get: () => scope });
    Perf.count("orm.query");
    Perf.count("orm.query", 2);
    expect(scope.byName["orm.query"].count).to.eq(3);
    expect(sink.metrics.filter((m) => m.kind === "counter")).to.have.length(2);
  });

  it("measure() accumulates span count + duration + max into the active scope", async () => {
    const scope: IPerfScope = { byName: {} };
    setPerfScopeBackend({ get: () => scope });
    await Perf.measure("orm.query", async () => 1);
    await Perf.measure("orm.query", async () => 2);
    const e = scope.byName["orm.query"];
    expect(e.count).to.eq(2);
    expect(e.totalMs).to.be.greaterThan(0);
    expect(e.maxMs).to.be.greaterThan(0);
  });

  it("flushScope() emits one rollup to sinks", () => {
    const scope: IPerfScope = { requestId: "r9", byName: { "orm.query": { count: 4, totalMs: 10, maxMs: 5 } } };
    Perf.flushScope(scope, { labels: { route: "/x" }, totalMs: 123 });
    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].requestId).to.eq("r9");
    expect(sink.rollups[0].byName["orm.query"].count).to.eq(4);
    expect(sink.rollups[0].totalMs).to.eq(123);
  });

  it("Enabled=false makes measure a pass-through with no emission", async () => {
    Perf.Enabled = false;
    const result = await Perf.measure("job", async () => 7);
    expect(result).to.eq(7);
    expect(sink.metrics).to.have.length(0);
    Perf.Enabled = true;
  });

  it("a throwing sink never breaks measure", async () => {
    class BadSink extends PerfSink {
      public collect(): void {
        throw new Error("sink down");
      }
    }
    DI.register(BadSink).as(PerfSink);
    DI.resolve(Array.ofType(PerfSink));
    Perf.refreshSinks();
    const result = await Perf.measure("job", async () => 5);
    expect(result).to.eq(5);
  });
});
