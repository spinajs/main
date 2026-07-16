import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Perf, PerfSink, IPerfMetric, Log } from "@spinajs/log";
import { wirePerfScope } from "../src/perf.js";
import { Measure } from "../src/perf/measure.js";

class RecordingSink extends PerfSink {
  public metrics: IPerfMetric[] = [];
  public collect(m: IPerfMetric): void {
    this.metrics.push(m);
  }
}

class Service {
  @Measure("svc.explicit")
  public async explicit(): Promise<number> {
    return 1;
  }

  @Measure()
  public async defaulted(): Promise<number> {
    return 2;
  }
}

describe("@Measure decorator", () => {
  let sink: RecordingSink;

  beforeEach(() => {
    DI.clearCache();
    (Log as any).Loggers.clear();
    DI.register(RecordingSink).as(PerfSink);
    DI.resolve(Array.ofType(PerfSink));
    Perf.refreshSinks();
    wirePerfScope();
    sink = (DI.resolve(Array.ofType(PerfSink)) as PerfSink[]).find((s) => s instanceof RecordingSink) as RecordingSink;
  });

  afterEach(() => DI.clearCache());

  it("emits a span with the explicit name and returns the value", async () => {
    const svc = new Service();
    const result = await svc.explicit();
    expect(result).to.eq(1);
    expect(sink.metrics.map((m) => m.name)).to.include("svc.explicit");
  });

  it("defaults the name to Class.method", async () => {
    const svc = new Service();
    await svc.defaulted();
    expect(sink.metrics.map((m) => m.name)).to.include("Service.defaulted");
  });
});
