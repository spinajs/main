import "mocha";
import { expect } from "chai";
import { LogWriter, RateLimitedLog, resetWarnOnce, warnOnce } from "../src/index.js";

function recorder() {
  const lines: [string, unknown[]][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push([level, args]);
  const log = { warn: record("warn"), error: record("error"), info: record("info"), debug: record("debug") } as unknown as LogWriter;
  return { log, lines };
}

describe("RateLimitedLog", () => {
  it("writes a key at most once per interval and reports what it suppressed", () => {
    let clock = 0;
    const { log, lines } = recorder();
    const rl = new RateLimitedLog(log, { intervalMs: 10, now: () => clock });

    expect(rl.warn("k", "hello")).to.equal(true);
    clock = 5;
    expect(rl.warn("k", "hello")).to.equal(false);
    expect(rl.warn("k", "hello")).to.equal(false);
    expect(rl.warn("other", "other")).to.equal(true);
    clock = 10;
    expect(rl.warn("k", "hello")).to.equal(true);
    expect(rl.warn("k", "hello")).to.equal(false);

    expect(lines).to.deep.equal([
      ["warn", ["hello"]],
      ["warn", ["other"]],
      ["warn", ["hello (2 more suppressed)"]],
    ]);
  });

  it("adds the suppressed count to a fields-form call and to an error-form message", () => {
    let clock = 0;
    const { log, lines } = recorder();
    const rl = new RateLimitedLog(log, { intervalMs: 10, now: () => clock });
    const err = new Error("boom");

    rl.error("f", { op: "a" }, "op ${op}");
    rl.error("f", { op: "a" }, "op ${op}");
    rl.error("e", err, "failed %s", "x");
    rl.error("e", err, "failed %s", "x");
    clock = 10;
    rl.error("f", { op: "a" }, "op ${op}");
    rl.error("e", err, "failed %s", "x");

    expect(lines.slice(2)).to.deep.equal([
      ["error", [{ op: "a", suppressed: 1 }, "op ${op} (1 more suppressed)"]],
      ["error", [err, "failed %s (1 more suppressed)", "x"]],
    ]);
  });

  it("caps lines across keys per interval", () => {
    let clock = 0;
    const { log, lines } = recorder();
    const rl = new RateLimitedLog(log, { intervalMs: 10, maxPerInterval: 2, now: () => clock });

    for (const k of ["a", "b", "c", "d"]) rl.warn(k, k);
    clock = 10;
    rl.warn("c", "c");

    expect(lines.map(([, args]) => args[0])).to.deep.equal(["a", "b", "c"]);
  });

  it("forgets the key written longest ago past maxKeys", () => {
    const { log, lines } = recorder();
    const rl = new RateLimitedLog(log, { intervalMs: Infinity, maxKeys: 2, now: () => 0 });

    for (const k of ["a", "b", "a", "c", "c", "a"]) rl.warn(k, k);

    expect(lines.map(([, args]) => args[0])).to.deep.equal(["a", "b", "c", "a"]);
  });

  it("resolves a getter source on each write and falls back to the console", () => {
    const { log, lines } = recorder();
    let current: LogWriter | undefined;
    const rl = new RateLimitedLog(() => current, { intervalMs: 0 });

    const warned: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      rl.warn("k", "early");
      current = log;
      rl.warn("k", "late");
    } finally {
      console.warn = orig;
    }

    expect(warned).to.deep.equal([["early"]]);
    expect(lines).to.deep.equal([["warn", ["late"]]]);
  });

  it("reset forgets every key", () => {
    const { log, lines } = recorder();
    const rl = new RateLimitedLog(log, { intervalMs: Infinity });
    rl.info("k", "one");
    rl.reset();
    rl.info("k", "two");
    expect(lines.map(([, args]) => args[0])).to.deep.equal(["one", "two"]);
  });
});

describe("warnOnce", () => {
  beforeEach(() => resetWarnOnce());

  it("warns once per key across callers and logs", () => {
    const first = recorder();
    const second = recorder();

    expect(warnOnce(first.log, "pkg:a", "a ${x}", 1)).to.equal(true);
    expect(warnOnce(second.log, "pkg:a", "a again")).to.equal(false);
    expect(warnOnce(second.log, "pkg:b", { x: 1 }, "b ${x}")).to.equal(true);

    expect(first.lines).to.deep.equal([["warn", ["a ${x}", 1]]]);
    expect(second.lines).to.deep.equal([["warn", [{ x: 1 }, "b ${x}"]]]);
  });

  it("goes to the console when the log getter throws", () => {
    const warned: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      warnOnce(() => {
        throw new Error("no Log");
      }, "pkg:c", "c");
    } finally {
      console.warn = orig;
    }
    expect(warned).to.deep.equal([["c"]]);
  });
});
