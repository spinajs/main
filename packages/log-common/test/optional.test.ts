import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Log, Logger, LogWriter, consoleLog, optionalLog } from "../src/index.js";

type Method = "info" | "warn" | "error";

function captureConsole<T>(fn: () => T): { result: T; lines: Record<Method, unknown[][]> } {
  const lines: Record<Method, unknown[][]> = { info: [], warn: [], error: [] };
  const orig = { info: console.info, warn: console.warn, error: console.error };
  for (const m of Object.keys(lines) as Method[]) {
    console[m] = (...args: unknown[]) => lines[m].push(args);
  }
  try {
    return { result: fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}

class RecordingLog {
  public static lines: [string, unknown[]][] = [];
  public Name = "recording";
  warn(...args: unknown[]) {
    RecordingLog.lines.push(["warn", args]);
  }
  error(...args: unknown[]) {
    RecordingLog.lines.push(["error", args]);
  }
}

function withRegisteredLog(fn: () => void): void {
  RecordingLog.lines = [];
  DI.register(RecordingLog as never).as(Log as never);
  try {
    fn();
  } finally {
    DI.uncache(RecordingLog as never);
    DI.unregister(RecordingLog as never);
  }
}

describe("consoleLog", () => {
  it("maps levels to console methods and drops trace and debug", () => {
    const { lines } = captureConsole(() => {
      consoleLog.trace("t");
      consoleLog.debug("d");
      consoleLog.info("i");
      consoleLog.success("s");
      consoleLog.warn("w");
      consoleLog.error("e");
      consoleLog.fatal("f");
      consoleLog.security("x");
    });
    expect(lines.info).to.deep.equal([["i"], ["s"]]);
    expect(lines.warn).to.deep.equal([["w"]]);
    expect(lines.error).to.deep.equal([["e"], ["f"], ["x"]]);
  });

  it("renders a fields-form call and prints its error after the line", () => {
    const err = new Error("boom");
    const { lines } = captureConsole(() => consoleLog.error({ op: "sync", error: err }, "op ${op} failed"));
    expect(lines.error).to.deep.equal([["op sync failed", err]]);
  });

  it("never throws when the console does", () => {
    const orig = console.warn;
    console.warn = () => {
      throw new Error("console down");
    };
    try {
      expect(() => consoleLog.warn("w")).to.not.throw();
    } finally {
      console.warn = orig;
    }
  });
});

describe("optionalLog", () => {
  it("writes to the console without resolving a Log when none is registered", () => {
    const before = DI.check(Log);
    const { lines } = captureConsole(() => optionalLog("opt-test").warn("w"));
    expect(lines.warn).to.deep.equal([["w"]]);
    expect(DI.check(Log)).to.equal(before);
    expect(DI.has(Log)).to.equal(false);
  });

  it("picks up a Log registered after its first write", () => {
    const log = optionalLog("opt-late");
    const { lines } = captureConsole(() => {
      log.warn("first");
      withRegisteredLog(() => log.warn("second"));
    });
    expect(lines.warn).to.deep.equal([["first"]]);
    expect(RecordingLog.lines).to.deep.equal([["warn", ["second"]]]);
  });

  it("falls back to the console when resolving or writing throws", () => {
    const failing = { warn: () => { throw new Error("target down"); } } as unknown as Log;
    const { lines } = captureConsole(() => {
      optionalLog("opt-throw", () => { throw new Error("no factory"); }).warn("a");
      optionalLog("opt-throw", () => failing).warn("b");
    });
    expect(lines.warn).to.deep.equal([["a"], ["b"]]);
  });

  it("caches the resolved Log", () => {
    let calls = 0;
    const log = optionalLog("opt-cache", () => {
      calls++;
      return new RecordingLog() as unknown as Log;
    });
    RecordingLog.lines = [];
    log.warn("a");
    log.error("b");
    expect(calls).to.equal(1);
    expect(RecordingLog.lines.map(([l]) => l)).to.deep.equal(["warn", "error"]);
  });
});

describe("@Logger optional", () => {
  class Service {
    @Logger("opt-service", { optional: true })
    public Log: LogWriter;
  }

  it("reads as consoleLog while no Log is registered", () => {
    expect(new Service().Log).to.equal(consoleLog);
  });

  it("resolves the registered Log on a later read", () => {
    withRegisteredLog(() => {
      const log = new Service().Log;
      expect(log).to.be.instanceOf(RecordingLog);
      log.warn("w");
    });
    expect(RecordingLog.lines).to.deep.equal([["warn", ["w"]]]);
  });

  it("without the option resolves the bare abstract Log, which cannot write", () => {
    class Strict {
      @Logger("opt-strict")
      public Log: Log;
    }
    try {
      expect(() => new Strict().Log.warn("w")).to.throw(TypeError);
    } finally {
      DI.uncache(Log as never);
    }
  });
});
