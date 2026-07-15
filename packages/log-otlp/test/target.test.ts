/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import * as sinon from "sinon";
import { expect } from "chai";
import { ResiliencePipelineBuilder } from "@spinajs/util";

import { OtlpLogTarget } from "./../src/index.js";

function buildTarget(extra?: any) {
  const target: any = new OtlpLogTarget({
    name: "Otlp",
    layout: "${datetime} ${level} ${message} (${logger})",
    interval: 100000, // effectively disable the timer; we drive flush() manually
    bufferSize: 100000,
    timeout: 1000,
    endpoint: "http://localhost:4318",
    resource: { "service.name": "spinajs-test" },
    ...extra,
  } as any);

  // @Logger injection does not run for a direct `new`; Log is a getter-only
  // accessor, so override it with a no-op logger for the test.
  Object.defineProperty(target, "Log", {
    configurable: true,
    value: { trace() {}, info() {}, warn() {}, error() {}, fatal() {}, debug() {}, security() {}, success() {} },
  });
  return target;
}

function entry(msg: string): any {
  return { Level: 2, Variables: { logger: "otlp", level: "INFO", message: msg } };
}

describe("OtlpLogTarget behavior", () => {
  afterEach(() => sinon.restore());

  it("is resolved after resolve()", () => {
    const target = buildTarget();
    expect(target.Resolved).to.eq(false);
    target.resolve();
    expect(target.Resolved).to.eq(true);
  });

  it("posts to /v1/logs with a payload matching the enqueued records", async () => {
    const target = buildTarget();
    target.resolve();

    const post = sinon.stub(target.AxiosInstance, "post").callsFake(() => Promise.resolve({ status: 200 }));

    target.write(entry("hello 1"));
    target.write(entry("hello 2"));

    await target.Queue.flush();

    expect(post.calledOnce).to.eq(true);
    expect(post.args[0][0]).to.eq("/v1/logs");

    const payload = post.args[0][1] as any;
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).to.have.length(2);
    expect(records[0].body).to.deep.eq({ stringValue: "hello 1" });
    expect(records[1].body).to.deep.eq({ stringValue: "hello 2" });

    // resource attribute propagated from options
    expect(payload.resourceLogs[0].resource.attributes).to.deep.include({ key: "service.name", value: { stringValue: "spinajs-test" } });

    expect(target.HasError).to.eq(false);
  });

  it("drops the batch and does not retry on a non-retryable error ( 401 )", async () => {
    const target = buildTarget();
    target.resolve();

    // no-retry passthrough so a ( non-retryable anyway ) error surfaces at once
    target.RetryPipeline = new ResiliencePipelineBuilder().build();

    const post = sinon.stub(target.AxiosInstance, "post").rejects({ response: { status: 401, headers: {} } });

    target.write(entry("dropped 1"));
    target.write(entry("dropped 2"));

    await target.Queue.flush();

    // (a) exactly one call - no retries for a permanent error
    expect(post.calledOnce).to.eq(true);
    // (b) the batch was dropped, not requeued -> the queue drained
    expect(target.Queue.size).to.eq(0);
    expect(target.HasError).to.eq(true);
  });

  it("invokes OnDropped for each entry on a non-retryable drop ( 401 )", async () => {
    const target = buildTarget();
    target.resolve();

    // no-retry passthrough so the non-retryable error surfaces at once and the
    // batch takes the drop path.
    target.RetryPipeline = new ResiliencePipelineBuilder().build();

    sinon.stub(target.AxiosInstance, "post").rejects({ response: { status: 401, headers: {} } });

    const dropped: any[] = [];
    target.OnDropped = (entry: any) => dropped.push(entry);

    const e1 = entry("undelivered 1");
    const e2 = entry("undelivered 2");
    target.write(e1);
    target.write(e2);

    await target.Queue.flush();

    // both undelivered entries reached the fallback hook, unwrapped to ILogEntry
    expect(dropped).to.have.length(2);
    expect(dropped[0]).to.eq(e1);
    expect(dropped[1]).to.eq(e2);
    // and the batch was still dropped ( not requeued )
    expect(target.Queue.size).to.eq(0);
    expect(target.HasError).to.eq(true);
  });

  it("retains the batch for retry on a retryable error ( 503 )", async () => {
    const target = buildTarget();
    target.resolve();

    // no-retry passthrough so the retryable error exhausts immediately and the
    // batch is requeued at the front without sleeping through backoff.
    target.RetryPipeline = new ResiliencePipelineBuilder().build();

    const post = sinon.stub(target.AxiosInstance, "post").rejects({ response: { status: 503, headers: {} } });

    target.write(entry("retry 1"));
    target.write(entry("retry 2"));

    await target.Queue.flush();

    expect(post.calledOnce).to.eq(true);
    // requeued -> still buffered for the next flush
    expect(target.Queue.size).to.eq(2);
    expect(target.HasError).to.eq(true);
  });
});
