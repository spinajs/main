/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import * as sinon from "sinon";
import { expect } from "chai";

import { GraphanaLokiLogTarget, isRetryableLokiError, retryAfterMs } from "./../src/index.js";

function buildTarget(extra?: any) {
  const target: any = new GraphanaLokiLogTarget({
    name: "Graphana",
    layout: "${datetime} ${level} ${message} (${logger})",
    interval: 100000, // effectively disable the timer; we drive flush() manually
    bufferSize: 100000,
    timeout: 1000,
    host: "http://localhost",
    auth: { username: "admin", password: "admin" },
    labels: { app: "spinajs-test" },
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
  return { Level: 4, Variables: { logger: "graphana", level: "INFO", message: msg, n_timestamp: Date.now() * 1000000 } };
}

describe("loki resilience helpers", () => {
  afterEach(() => sinon.restore());

  describe("isRetryableLokiError", () => {
    it("network error ( no response ) is retryable", () => {
      expect(isRetryableLokiError(new Error("boom"))).to.eq(true);
      expect(isRetryableLokiError({ code: "ECONNREFUSED" })).to.eq(true);
      expect(isRetryableLokiError({ code: "ETIMEDOUT" })).to.eq(true);
    });

    it("429 / 502 / 503 / 504 are retryable", () => {
      for (const status of [429, 502, 503, 504]) {
        expect(isRetryableLokiError({ response: { status, headers: {} } }), `status ${status}`).to.eq(true);
      }
    });

    it("4xx client errors ( 400 / 401 / 403 / 404 ) are not retryable", () => {
      for (const status of [400, 401, 403, 404]) {
        expect(isRetryableLokiError({ response: { status, headers: {} } }), `status ${status}`).to.eq(false);
      }
    });

    it("other non-retryable statuses ( eg. 500 ) are not retryable", () => {
      expect(isRetryableLokiError({ response: { status: 500, headers: {} } })).to.eq(false);
    });
  });

  describe("retryAfterMs", () => {
    it("numeric delta-seconds header -> milliseconds", () => {
      expect(retryAfterMs({ response: { headers: { "retry-after": 5 } } })).to.eq(5000);
      expect(retryAfterMs({ response: { headers: { "retry-after": "3" } } })).to.eq(3000);
    });

    it("missing header -> undefined", () => {
      expect(retryAfterMs({ response: { headers: {} } })).to.eq(undefined);
      expect(retryAfterMs(new Error("boom"))).to.eq(undefined);
    });

    it("HTTP-date header -> non-negative delay", () => {
      const future = new Date(Date.now() + 4000).toUTCString();
      const ms = retryAfterMs({ response: { headers: { "retry-after": future } } });
      expect(ms).to.be.a("number");
      expect(ms).to.be.greaterThan(0);
    });
  });
});

describe("loki non-retryable flush", () => {
  afterEach(() => sinon.restore());

  it("drops the batch and does not retry on a non-retryable error ( 401 )", async () => {
    const target = buildTarget();
    target.resolve();
    clearInterval(target.FlushTimer); // drive flush manually

    const post = sinon.stub(target.AxiosInstance, "post").rejects({ response: { status: 401, headers: {} } });

    target.WriteEntries.push(entry("dropped message 1"));
    target.WriteEntries.push(entry("dropped message 2"));

    await target.flush();

    // (a) exactly one call - no retries for a permanent error
    expect(post.calledOnce).to.eq(true);
    // (b) the batch was dropped, not retained
    expect(target.WriteEntries.length).to.eq(0);
    expect(target.HasError).to.eq(true);
  });
});
