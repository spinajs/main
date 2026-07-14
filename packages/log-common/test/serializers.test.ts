import "mocha";
import { expect } from "chai";
import { serializeError, safeStringify, applySerializers, registerSerializer, serializers, LogSerializer } from "../src/serializers.js";

describe("serializeError", () => {
  it("serializes a plain Error ( name / message / stack )", () => {
    const err = new Error("boom");
    const result = serializeError(err);

    expect(result).to.be.an("object");
    expect(result!.name).to.equal("Error");
    expect(result!.message).to.equal("boom");
    expect(result!.stack).to.be.a("string").and.contain("boom");
  });

  it("returns undefined for a non-error input", () => {
    expect(serializeError("just a string")).to.equal(undefined);
    expect(serializeError(42)).to.equal(undefined);
    expect(serializeError({ message: "not an error" })).to.equal(undefined);
    expect(serializeError(null)).to.equal(undefined);
    expect(serializeError(undefined)).to.equal(undefined);
  });

  it("includes `code` when present ( e.g. ECONNREFUSED )", () => {
    const err = new Error("connection refused") as Error & { code?: string };
    err.code = "ECONNREFUSED";

    const result = serializeError(err);
    expect(result!.code).to.equal("ECONNREFUSED");
  });

  it("includes `signal` when present", () => {
    const err = new Error("killed") as Error & { signal?: string };
    err.signal = "SIGTERM";

    const result = serializeError(err);
    expect(result!.signal).to.equal("SIGTERM");
  });

  it("omits `code` / `signal` when absent", () => {
    const result = serializeError(new Error("plain"));
    expect(result).to.not.have.property("code");
    expect(result).to.not.have.property("signal");
  });

  it("walks the .cause chain into the combined stack ( Caused by: )", () => {
    const root = new Error("root cause failure");
    const wrapper = new Error("wrapper failed", { cause: root });

    const result = serializeError(wrapper);
    expect(result!.stack).to.contain("wrapper failed");
    expect(result!.stack).to.contain("Caused by:");
    expect(result!.stack).to.contain("root cause failure");
  });

  it("surfaces every inner error of an AggregateError", () => {
    const inner1 = new Error("inner one");
    const inner2 = new Error("inner two");
    const agg = new AggregateError([inner1, inner2], "aggregate failed");

    const result = serializeError(agg);
    expect(result!.stack).to.contain("Caused by:");
    expect(result!.stack).to.contain("inner one");
    expect(result!.stack).to.contain("inner two");
  });

  it("does not hang on a self-referential cause ( depth cap )", () => {
    const err = new Error("self") as Error & { cause?: unknown };
    err.cause = err; // self-reference

    // If the depth cap / cycle guard is broken this would loop forever.
    const result = serializeError(err);
    expect(result!.name).to.equal("Error");
    expect(result!.message).to.equal("self");
    expect(result!.stack).to.be.a("string");
  });

  it("never throws even when a property access throws", () => {
    const err = new Error("tricky");
    Object.defineProperty(err, "code", {
      get() {
        throw new Error("getter blew up");
      },
    });

    expect(() => serializeError(err)).to.not.throw();
    const result = serializeError(err);
    expect(result!.message).to.equal("tricky");
  });
});

describe("safeStringify", () => {
  it("matches JSON.stringify for a normal object", () => {
    const obj = { a: 1, b: "two", c: [3, 4], d: { e: true } };
    expect(safeStringify(obj)).to.equal(JSON.stringify(obj));
  });

  it("honours the indent argument", () => {
    const obj = { a: 1 };
    expect(safeStringify(obj, 2)).to.equal(JSON.stringify(obj, undefined, 2));
  });

  it("returns valid JSON with [Circular] for a circular object and does not throw", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj; // circular

    let out = "";
    expect(() => {
      out = safeStringify(obj);
    }).to.not.throw();

    // Must be VALID JSON, not a crash and not [object Object].
    expect(() => JSON.parse(out)).to.not.throw();
    expect(out).to.contain("[Circular]");

    const parsed = JSON.parse(out);
    expect(parsed.a).to.equal(1);
    expect(parsed.self).to.equal("[Circular]");
  });

  it("does not throw for an object with a throwing getter ( returns some string )", () => {
    const obj = {
      get boom(): never {
        throw new Error("getter throws");
      },
    };

    let out: string | undefined;
    expect(() => {
      out = safeStringify(obj);
    }).to.not.throw();
    expect(out).to.be.a("string");
  });
});

describe("applySerializers / registry", () => {
  // Snapshot + restore the shared registry so custom registrations in one test
  // never leak into another.
  let snapshot: Array<[string, LogSerializer]>;
  beforeEach(() => {
    snapshot = [...serializers.entries()];
  });
  afterEach(() => {
    serializers.clear();
    for (const [k, v] of snapshot) {
      serializers.set(k, v);
    }
  });

  it("serializes an `error` Error field into the structured record ( default serializer )", () => {
    const vars: Record<string, unknown> = { error: new Error("boom") };
    applySerializers(vars);

    expect(vars.error).to.be.an("object");
    expect(vars.error).to.not.be.instanceOf(Error);
    const e = vars.error as { name: string; message: string; stack?: string };
    expect(e.name).to.equal("Error");
    expect(e.message).to.equal("boom");
    expect(e.stack).to.be.a("string").and.contain("boom");
  });

  it("leaves a non-Error `error` value untouched ( serializer returned undefined )", () => {
    const original = { message: "not an error" };
    const vars: Record<string, unknown> = { error: original };
    applySerializers(vars);

    // serializeError returns undefined for a non-Error -> original stays put.
    expect(vars.error).to.equal(original);
  });

  it("skips absent and null/undefined fields", () => {
    const vars: Record<string, unknown> = { error: null };
    applySerializers(vars);
    expect(vars.error).to.equal(null);

    const empty: Record<string, unknown> = {};
    applySerializers(empty);
    expect(empty).to.not.have.property("error");
  });

  it("leaves unrelated fields untouched", () => {
    const vars: Record<string, unknown> = { error: new Error("x"), message: "hello", logger: "lg" };
    applySerializers(vars);
    expect(vars.message).to.equal("hello");
    expect(vars.logger).to.equal("lg");
  });

  it("degrades a throwing serializer to { serializerError } and does not throw", () => {
    registerSerializer("boomField", () => {
      throw new Error("serializer exploded");
    });

    const vars: Record<string, unknown> = { boomField: "anything" };
    expect(() => applySerializers(vars)).to.not.throw();
    expect(vars.boomField).to.deep.equal({ serializerError: "serializer exploded" });
  });

  it("registerSerializer overrides an existing field serializer", () => {
    registerSerializer("error", () => "OVERRIDDEN");
    const vars: Record<string, unknown> = { error: new Error("boom") };
    applySerializers(vars);
    expect(vars.error).to.equal("OVERRIDDEN");
  });

  it("does NOT overwrite when a custom serializer returns undefined", () => {
    const original = { keep: true };
    registerSerializer("custom", () => undefined);
    const vars: Record<string, unknown> = { custom: original };
    applySerializers(vars);
    expect(vars.custom).to.equal(original);
  });
});
