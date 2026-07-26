import "mocha";
import { expect } from "chai";
import { ILogEntry, LogLevel } from "../src/index.js";
import { LevelFilter } from "../src/filters/LevelFilter.js";
import { MatchFilter } from "../src/filters/MatchFilter.js";
import { RateLimitFilter } from "../src/filters/RateLimitFilter.js";

function entry(level: LogLevel, message: string, extra: Record<string, unknown> = {}): ILogEntry {
  return {
    Level: level,
    Variables: {
      logger: "app",
      message,
      level: String(level),
      ...extra,
    } as any,
  };
}

describe("LevelFilter", () => {
  it("drops entries below min, keeps warn+ ( min: warn )", () => {
    const f = new LevelFilter({ type: "LevelFilter", min: "warn" });

    expect(f.apply(entry(LogLevel.Trace, "t"))).to.eq(null);
    expect(f.apply(entry(LogLevel.Debug, "d"))).to.eq(null);
    expect(f.apply(entry(LogLevel.Info, "i"))).to.eq(null);

    const w = entry(LogLevel.Warn, "w");
    expect(f.apply(w)).to.eq(w);
    const e = entry(LogLevel.Error, "e");
    expect(f.apply(e)).to.eq(e);
  });

  it("drops entries above max ( max: warn )", () => {
    const f = new LevelFilter({ type: "LevelFilter", max: "warn" });

    const i = entry(LogLevel.Info, "i");
    expect(f.apply(i)).to.eq(i);
    const w = entry(LogLevel.Warn, "w");
    expect(f.apply(w)).to.eq(w);
    expect(f.apply(entry(LogLevel.Error, "e"))).to.eq(null);
  });

  it("keeps a level window ( min: info, max: warn )", () => {
    const f = new LevelFilter({ type: "LevelFilter", min: "info", max: "warn" });

    expect(f.apply(entry(LogLevel.Debug, "d"))).to.eq(null);
    const i = entry(LogLevel.Info, "i");
    expect(f.apply(i)).to.eq(i);
    const w = entry(LogLevel.Warn, "w");
    expect(f.apply(w)).to.eq(w);
    expect(f.apply(entry(LogLevel.Error, "e"))).to.eq(null);
  });
});

describe("MatchFilter", () => {
  it("keep mode keeps only messages that match the pattern", () => {
    const f = new MatchFilter({ type: "MatchFilter", pattern: "timeout", mode: "keep" });

    const hit = entry(LogLevel.Info, "connection timeout after 30s");
    expect(f.apply(hit)).to.eq(hit);
    expect(f.apply(entry(LogLevel.Info, "all good"))).to.eq(null);
  });

  it("drop mode drops messages that match the pattern", () => {
    const f = new MatchFilter({ type: "MatchFilter", pattern: "timeout", mode: "drop" });

    expect(f.apply(entry(LogLevel.Info, "connection timeout"))).to.eq(null);
    const kept = entry(LogLevel.Info, "all good");
    expect(f.apply(kept)).to.eq(kept);
  });

  it("defaults to keep mode when mode omitted", () => {
    const f = new MatchFilter({ type: "MatchFilter", pattern: "boom" });

    const hit = entry(LogLevel.Info, "boom happened");
    expect(f.apply(hit)).to.eq(hit);
    expect(f.apply(entry(LogLevel.Info, "quiet"))).to.eq(null);
  });

  it("can test an arbitrary field via `field` and honours flags", () => {
    const f = new MatchFilter({ type: "MatchFilter", pattern: "^err$", field: "code", flags: "i", mode: "keep" });

    const hit = entry(LogLevel.Info, "whatever", { code: "ERR" });
    expect(f.apply(hit)).to.eq(hit);
    expect(f.apply(entry(LogLevel.Info, "whatever", { code: "ok" }))).to.eq(null);
  });

  it("degrades to a no-op ( pass-through ) on an invalid pattern", () => {
    // unbalanced group => invalid RegExp
    const f = new MatchFilter({ type: "MatchFilter", pattern: "([a-z", mode: "keep" });

    const e = entry(LogLevel.Info, "anything");
    // no-op: entry passes through regardless of mode
    expect(f.apply(e)).to.eq(e);
  });
});

describe("RateLimitFilter", () => {
  it("keeps up to `limit` per window then drops overflow, resets after the window", () => {
    let clock = 0;
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 2, intervalSeconds: 10 }, () => clock);

    // first two kept
    expect(f.apply(entry(LogLevel.Info, "a"))).to.not.eq(null);
    clock = 1000;
    expect(f.apply(entry(LogLevel.Info, "b"))).to.not.eq(null);
    // third within window dropped
    clock = 2000;
    expect(f.apply(entry(LogLevel.Info, "c"))).to.eq(null);
    clock = 3000;
    expect(f.apply(entry(LogLevel.Info, "d"))).to.eq(null);

    // window elapsed ( >= 10s ) - counter resets
    clock = 11000;
    expect(f.apply(entry(LogLevel.Info, "e"))).to.not.eq(null);
    clock = 12000;
    expect(f.apply(entry(LogLevel.Info, "f"))).to.not.eq(null);
    clock = 13000;
    expect(f.apply(entry(LogLevel.Info, "g"))).to.eq(null);
  });

  it("buckets the limit per `key` field ( independent windows )", () => {
    let clock = 0;
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, key: "logger" }, () => clock);

    // each logger gets its own window
    expect(f.apply(entry(LogLevel.Info, "x", { logger: "a" }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "y", { logger: "b" }))).to.not.eq(null);
    // second for logger a within window -> dropped
    expect(f.apply(entry(LogLevel.Info, "z", { logger: "a" }))).to.eq(null);
  });
});
