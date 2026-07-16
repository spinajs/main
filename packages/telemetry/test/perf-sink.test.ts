import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Metrics } from "../src/metrics.js";
import { PromMetricSink } from "../src/PromMetricSink.js";

describe("PromMetricSink", () => {
  beforeEach(() => DI.clearCache());
  afterEach(() => DI.clearCache());

  it("observes a span duration into a prom histogram", async () => {
    const sink = DI.resolve(PromMetricSink) as PromMetricSink;
    sink.collect({ name: "orm.query", kind: "span", durationMs: 42, labels: { driver: "sqlite" } });

    const metrics = DI.resolve(Metrics) as Metrics;
    const text = await metrics.render();
    expect(text).to.match(/perf_span_duration_ms/);
    expect(text).to.match(/orm\.query|orm_query/);
  });

  it("increments a prom counter for a counter metric", async () => {
    const sink = DI.resolve(PromMetricSink) as PromMetricSink;
    sink.collect({ name: "orm.query", kind: "counter", value: 2 });
    const metrics = DI.resolve(Metrics) as Metrics;
    const text = await metrics.render();
    expect(text).to.match(/perf_events_total/);
  });
});
