import "mocha";
import { expect } from "chai";
import { ILogEntry, LogLevel } from "../src/index.js";
import { LevelFilter } from "../src/filters/LevelFilter.js";
import { MatchFilter } from "../src/filters/MatchFilter.js";
import { RateLimitFilter } from "../src/filters/RateLimitFilter.js";
import { InvalidOption } from "@spinajs/exceptions";

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

  it("refuses a missing or invalid limit, interval, maxKeys or level", () => {
    const make = (o: Record<string, unknown>) => () => new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 1, ...o } as any);
    expect(make({ limit: undefined })).to.throw(InvalidOption, "limit");
    expect(make({ limit: 0 })).to.throw(InvalidOption, "limit");
    expect(make({ limit: 1.5 })).to.throw(InvalidOption, "limit");
    expect(make({ intervalSeconds: undefined })).to.throw(InvalidOption, "intervalSeconds");
    expect(make({ intervalSeconds: 0 })).to.throw(InvalidOption, "intervalSeconds");
    expect(make({ intervalSeconds: Infinity })).to.throw(InvalidOption, "intervalSeconds");
    expect(make({ maxKeys: 0 })).to.throw(InvalidOption, "maxKeys");
    expect(make({ level: "loud" })).to.throw(InvalidOption, "level");
    expect(make({ maxLevel: "loud" })).to.throw(InvalidOption, "maxLevel");
  });

  it("buckets by several variables, a missing one counting as its own value", () => {
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, key: ["a", "b"] }, () => 0);

    expect(f.apply(entry(LogLevel.Info, "1", { a: "x|y", b: "z" }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "2", { a: "x", b: "y|z" }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "3", { a: "x" }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "4", { a: "x" }))).to.eq(null);
    expect(f.apply(entry(LogLevel.Info, "5", { a: "x|y", b: "z" }))).to.eq(null);
  });

  it("limits only the loggers matching `logger`, others pass and are not counted", () => {
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, logger: ["queue.*", "http"] }, () => 0);

    expect(f.apply(entry(LogLevel.Info, "a", { logger: "queue.amqp" }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "b", { logger: "queue.stomp" }))).to.eq(null);
    expect(f.apply(entry(LogLevel.Info, "c", { logger: "http" }))).to.eq(null);
    for (let i = 0; i < 3; i++) expect(f.apply(entry(LogLevel.Info, "d", { logger: "orm" }))).to.not.eq(null);
  });

  it("limits only entries whose variables equal `where`", () => {
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, where: { event: "refused", code: 403 } }, () => 0);

    expect(f.apply(entry(LogLevel.Warn, "a", { event: "refused", code: 403 }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Warn, "b", { event: "refused", code: 403 }))).to.eq(null);
    expect(f.apply(entry(LogLevel.Warn, "c", { event: "refused", code: "403" }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Warn, "d", { event: "other", code: 403 }))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Warn, "e"))).to.not.eq(null);
  });

  it("limits only levels within level..maxLevel", () => {
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, level: "info", maxLevel: "warn" }, () => 0);

    expect(f.apply(entry(LogLevel.Warn, "w"))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "i"))).to.eq(null);
    expect(f.apply(entry(LogLevel.Debug, "d"))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Error, "e"))).to.not.eq(null);
    expect(f.apply(entry(LogLevel.Error, "e"))).to.not.eq(null);
  });

  it("notes the drops of the previous window on the next kept entry of the bucket", () => {
    let clock = 0;
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, key: "k" }, () => clock);

    expect(f.apply(entry(LogLevel.Info, "a", { k: 1 }))!.Variables.message).to.eq("a");
    f.apply(entry(LogLevel.Info, "a", { k: 1 }));
    f.apply(entry(LogLevel.Info, "a", { k: 1 }));
    expect(f.apply(entry(LogLevel.Info, "b", { k: 2 }))!.Variables.message).to.eq("b");

    clock = 10_000;
    const next = f.apply(entry(LogLevel.Info, "a", { k: 1 }))!;
    expect(next.Variables.message).to.eq("a (2 suppressed)");
    expect((next.Variables as any).suppressed).to.eq(2);
    expect(f.apply(entry(LogLevel.Info, "b", { k: 2 }))!.Variables.message, "nothing dropped, no note").to.eq("b");

    clock = 20_000;
    expect(f.apply(entry(LogLevel.Info, "a", { k: 1 }))!.Variables.message, "the count is reported once").to.eq("a");
  });

  it("reportSuppressed: false drops without a note", () => {
    let clock = 0;
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, reportSuppressed: false }, () => clock);

    f.apply(entry(LogLevel.Info, "a"));
    expect(f.apply(entry(LogLevel.Info, "a"))).to.eq(null);
    clock = 10_000;
    const next = f.apply(entry(LogLevel.Info, "a"))!;
    expect(next.Variables.message).to.eq("a");
    expect((next.Variables as any).suppressed).to.eq(undefined);
  });

  it("keeps at most maxKeys buckets, dropping expired ones first, then the oldest", () => {
    let clock = 0;
    const f = new RateLimitFilter({ type: "RateLimitFilter", limit: 1, intervalSeconds: 10, key: "k", maxKeys: 2 }, () => clock);

    f.apply(entry(LogLevel.Info, "a", { k: "a" }));
    clock = 5_000;
    f.apply(entry(LogLevel.Info, "b", { k: "b" }));
    // a third bucket evicts "a", the oldest, so "a" starts a fresh window
    f.apply(entry(LogLevel.Info, "c", { k: "c" }));
    expect(f.apply(entry(LogLevel.Info, "a", { k: "a" })), "a was forgotten").to.not.eq(null);
    expect(f.apply(entry(LogLevel.Info, "c", { k: "c" })), "c is still counted").to.eq(null);

    clock = 16_000;
    // "c" and "a" ( both opened at 5 s ) have expired, so pruning makes room without evicting a live bucket
    expect(f.apply(entry(LogLevel.Info, "d", { k: "d" }))).to.not.eq(null);
    expect((f as any).windows.size).to.be.at.most(2);
  });
});
