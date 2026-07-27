import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Perf, PerfSink, IPerfMetric } from "@spinajs/log-common";
import { LogContext } from "../src/context.js";
import { wirePerfScope } from "../src/perf.js";

class RecordingSink extends PerfSink {
  public metrics: IPerfMetric[] = [];
  public collect(m: IPerfMetric): void {
    this.metrics.push(m);
  }
}

describe("Perf scope wiring (node)", () => {
  beforeEach(() => {
    DI.clearCache();
    DI.register(RecordingSink).as(PerfSink);
    DI.resolve(Array.ofType(PerfSink));
    Perf.refreshSinks();
    wirePerfScope();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it("accumulates into a scope stored on the async LogContext", async () => {
    await LogContext.with({ perf: { requestId: "r1", byName: {} } }, async () => {
      await Perf.measure("orm.query", async () => 1);
      await Perf.measure("orm.query", async () => 2);
      const scope = LogContext.active().perf as { byName: Record<string, { count: number }> };
      expect(scope.byName["orm.query"].count).to.eq(2);
    });
  });

  it("isolates scopes across concurrent async contexts", async () => {
    const runOne = (id: string) =>
      LogContext.with({ perf: { requestId: id, byName: {} }, requestId: id }, async () => {
        await Perf.measure("orm.query", async () => new Promise((r) => setTimeout(r, 10)));
        return (LogContext.active().perf as { byName: Record<string, { count: number }> }).byName["orm.query"].count;
      });

    const [a, b] = await Promise.all([runOne("A"), runOne("B")]);
    // Each context saw exactly ONE query — no cross-contamination ( the bug the
    // old shared Log.Timers map had ).
    expect(a).to.eq(1);
    expect(b).to.eq(1);
  });

  it("does not accumulate outside any scope", async () => {
    await Perf.measure("orm.query", async () => 1);
    expect(LogContext.active().perf).to.eq(undefined);
  });
});
