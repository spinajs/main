import "mocha";
import { expect } from "chai";
import { parseTraceparent, randomTraceId, randomSpanId, formatTraceparent, newTraceContext } from "../src/traceparent.js";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("traceparent utility", () => {
  describe("parseTraceparent", () => {
    it("accepts a valid sampled header and returns the parts + sampled", () => {
      const p = parseTraceparent(VALID);
      expect(p).to.not.be.null;
      expect(p!.version).to.eq("00");
      expect(p!.traceId).to.eq(TRACE_ID);
      expect(p!.parentId).to.eq(SPAN_ID);
      expect(p!.flags).to.eq("01");
      expect(p!.sampled).to.eq(true);
    });

    it("parses the not-sampled flag", () => {
      const p = parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`);
      expect(p).to.not.be.null;
      expect(p!.sampled).to.eq(false);
    });

    it("is case-insensitive and lowercases the output", () => {
      const p = parseTraceparent(`00-${TRACE_ID.toUpperCase()}-${SPAN_ID.toUpperCase()}-01`);
      expect(p).to.not.be.null;
      expect(p!.traceId).to.eq(TRACE_ID);
      expect(p!.parentId).to.eq(SPAN_ID);
    });

    it("rejects undefined / null / empty", () => {
      expect(parseTraceparent(undefined)).to.be.null;
      expect(parseTraceparent(null)).to.be.null;
      expect(parseTraceparent("")).to.be.null;
    });

    it("rejects wrong length", () => {
      expect(parseTraceparent(`00-${TRACE_ID}-abc-01`)).to.be.null;
      expect(parseTraceparent(`00-${TRACE_ID}${TRACE_ID}-${SPAN_ID}-01`)).to.be.null;
    });

    it("rejects non-hex", () => {
      expect(parseTraceparent(`00-zzf92f3577b34da6a3ce929d0e0e4736-${SPAN_ID}-01`)).to.be.null;
    });

    it("rejects all-zero trace id", () => {
      expect(parseTraceparent(`00-00000000000000000000000000000000-${SPAN_ID}-01`)).to.be.null;
    });

    it("rejects all-zero span id", () => {
      expect(parseTraceparent(`00-${TRACE_ID}-0000000000000000-01`)).to.be.null;
    });

    it("rejects version ff", () => {
      expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).to.be.null;
    });
  });

  describe("randomTraceId / randomSpanId", () => {
    it("randomTraceId returns 32 lowercase-hex chars", () => {
      const id = randomTraceId();
      expect(id).to.match(/^[0-9a-f]{32}$/);
    });

    it("randomSpanId returns 16 lowercase-hex chars", () => {
      const id = randomSpanId();
      expect(id).to.match(/^[0-9a-f]{16}$/);
    });

    it("varies between calls", () => {
      expect(randomTraceId()).to.not.eq(randomTraceId());
      expect(randomSpanId()).to.not.eq(randomSpanId());
    });
  });

  describe("formatTraceparent", () => {
    it("round-trips with parseTraceparent ( sampled )", () => {
      const ctx = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true };
      const header = formatTraceparent(ctx);
      expect(header).to.eq(VALID);
      const p = parseTraceparent(header);
      expect(p!.traceId).to.eq(ctx.traceId);
      expect(p!.parentId).to.eq(ctx.spanId);
      expect(p!.sampled).to.eq(true);
    });

    it("round-trips with parseTraceparent ( not sampled )", () => {
      const ctx = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: false };
      const p = parseTraceparent(formatTraceparent(ctx));
      expect(p!.sampled).to.eq(false);
    });
  });

  describe("newTraceContext", () => {
    it("continues a valid inbound trace: preserves traceId, mints a different spanId", () => {
      const ctx = newTraceContext(VALID);
      expect(ctx.traceId).to.eq(TRACE_ID);
      expect(ctx.spanId).to.match(/^[0-9a-f]{16}$/);
      expect(ctx.spanId).to.not.eq(SPAN_ID);
      expect(ctx.sampled).to.eq(true);
    });

    it("inherits the inbound sampled=false decision", () => {
      const ctx = newTraceContext(`00-${TRACE_ID}-${SPAN_ID}-00`);
      expect(ctx.traceId).to.eq(TRACE_ID);
      expect(ctx.sampled).to.eq(false);
    });

    it("starts a new sampled trace when no / invalid header", () => {
      const ctx = newTraceContext(undefined);
      expect(ctx.traceId).to.match(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).to.match(/^[0-9a-f]{16}$/);
      expect(ctx.sampled).to.eq(true);

      const bad = newTraceContext("not-a-traceparent");
      expect(bad.traceId).to.match(/^[0-9a-f]{32}$/);
    });
  });
});
