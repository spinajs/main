/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";

import { toOtlp, anyValue, isRetryableOtlpError, retryAfterMs, IOtlpRecord } from "./../src/index.js";

function record(level: number, vars: any): IOtlpRecord {
  return { entry: { Level: level, Variables: vars }, timeUnixNano: "1700000000000000000" } as any;
}

describe("OTLP mapping - toOtlp", () => {
  it("produces the right envelope shape with resource + scope", () => {
    const payload: any = toOtlp([record(2, { level: "INFO", message: "hello", logger: "test" })], { "service.name": "svc" }, "@spinajs/log");

    expect(payload).to.have.property("resourceLogs").that.is.an("array").with.length(1);
    const rl = payload.resourceLogs[0];

    // resource attributes present
    expect(rl.resource.attributes).to.deep.include({ key: "service.name", value: { stringValue: "svc" } });

    expect(rl.scopeLogs).to.be.an("array").with.length(1);
    expect(rl.scopeLogs[0].scope).to.deep.eq({ name: "@spinajs/log" });
    expect(rl.scopeLogs[0].logRecords).to.be.an("array").with.length(1);
  });

  it("maps severity, severityText, body and timestamps ( error -> 17 )", () => {
    const payload: any = toOtlp([record(5, { level: "ERROR", message: "boom" })]);
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(lr.severityNumber).to.eq(17); // LogLevel.Error -> 17
    expect(lr.severityText).to.eq("ERROR");
    expect(lr.body).to.deep.eq({ stringValue: "boom" });
    expect(lr.timeUnixNano).to.eq("1700000000000000000");
    expect(lr.observedTimeUnixNano).to.eq("1700000000000000000");
  });

  it("empty / missing message body defaults to empty string", () => {
    const payload: any = toOtlp([record(2, { level: "INFO" })]);
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(lr.body).to.deep.eq({ stringValue: "" });
  });

  it("promotes traceId / spanId to top-level fields, not attributes", () => {
    const payload: any = toOtlp([record(2, { level: "INFO", message: "m", traceId: "abc123", spanId: "def456" })]);
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(lr.traceId).to.eq("abc123");
    expect(lr.spanId).to.eq("def456");

    const attrKeys = lr.attributes.map((a: any) => a.key);
    expect(attrKeys).to.not.include("traceId");
    expect(attrKeys).to.not.include("spanId");
  });

  it("maps a structured error to exception.* semantic attributes", () => {
    const payload: any = toOtlp([
      record(5, {
        level: "ERROR",
        message: "failed",
        error: { name: "TypeError", message: "x is not a function", stack: "TypeError: x is not a function\n  at foo", code: "ERR" },
      }),
    ]);
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = lr.attributes as any[];

    const byKey = (k: string) => attrs.find((a) => a.key === k)?.value;
    expect(byKey("exception.type")).to.deep.eq({ stringValue: "TypeError" });
    expect(byKey("exception.message")).to.deep.eq({ stringValue: "x is not a function" });
    expect(byKey("exception.stacktrace")).to.deep.eq({ stringValue: "TypeError: x is not a function\n  at foo" });

    // the raw `error` object is not emitted as its own attribute
    expect(attrs.find((a) => a.key === "error")).to.eq(undefined);
  });

  it("maps other variables to attributes via anyValue ( string / int / double / bool )", () => {
    const payload: any = toOtlp([
      record(2, {
        level: "INFO",
        message: "m",
        logger: "test",
        count: 3,
        ratio: 1.5,
        active: true,
      }),
    ]);
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as any[];
    const byKey = (k: string) => attrs.find((a) => a.key === k)?.value;

    expect(byKey("logger")).to.deep.eq({ stringValue: "test" });
    expect(byKey("count")).to.deep.eq({ intValue: "3" });
    expect(byKey("ratio")).to.deep.eq({ doubleValue: 1.5 });
    expect(byKey("active")).to.deep.eq({ boolValue: true });

    // reserved keys excluded from attributes
    const keys = attrs.map((a) => a.key);
    expect(keys).to.not.include("message");
    expect(keys).to.not.include("level");
  });
});

describe("OTLP anyValue", () => {
  it("string", () => expect(anyValue("s")).to.deep.eq({ stringValue: "s" }));
  it("boolean", () => expect(anyValue(false)).to.deep.eq({ boolValue: false }));
  it("integer number", () => expect(anyValue(42)).to.deep.eq({ intValue: "42" }));
  it("non-integer number", () => expect(anyValue(3.14)).to.deep.eq({ doubleValue: 3.14 }));
  it("object -> stringValue via safeStringify", () => {
    expect(anyValue({ a: 1 })).to.deep.eq({ stringValue: '{"a":1}' });
  });
  it("array -> stringValue via safeStringify", () => {
    expect(anyValue([1, 2])).to.deep.eq({ stringValue: "[1,2]" });
  });
});

describe("OTLP resilience helpers", () => {
  describe("isRetryableOtlpError", () => {
    it("network error ( no response ) is retryable", () => {
      expect(isRetryableOtlpError(new Error("boom"))).to.eq(true);
      expect(isRetryableOtlpError({ code: "ECONNREFUSED" })).to.eq(true);
      expect(isRetryableOtlpError({ code: "ETIMEDOUT" })).to.eq(true);
    });

    it("429 / 502 / 503 / 504 are retryable", () => {
      for (const status of [429, 502, 503, 504]) {
        expect(isRetryableOtlpError({ response: { status, headers: {} } }), `status ${status}`).to.eq(true);
      }
    });

    it("4xx client errors ( 400 / 401 / 404 ) and 500 are not retryable", () => {
      for (const status of [400, 401, 404, 500]) {
        expect(isRetryableOtlpError({ response: { status, headers: {} } }), `status ${status}`).to.eq(false);
      }
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
