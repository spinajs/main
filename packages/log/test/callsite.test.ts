import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration, format } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log, captureCallsite } from "../src/index.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// MemoryTarget is a @Singleton ( one instance process-wide ), so a config can
// only carry ONE Memory sink. The two gating cases ( layout WITH vs WITHOUT
// ${callsite} ) therefore live in separate describe blocks, each clearing the
// DI cache and installing its own single-Memory config.
const MEMORY_TARGET = { name: "Memory", type: "MemoryTarget" };

// --- config whose Memory layout DOES reference ${callsite} -> gating ON ---
class CallsiteOnConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Memory", type: "MemoryTarget", layout: "${message} @ ${callsite}" }],
        rules: [{ name: "*", level: "trace", target: "Memory" }],
      },
    };
  }
}

// --- config whose Memory layout does NOT reference ${callsite} -> gating OFF ---
class CallsiteOffConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Memory", type: "MemoryTarget", layout: "${datetime} ${level} ${message}" }],
        rules: [{ name: "*", level: "trace", target: "Memory" }],
      },
    };
  }
}

describe("callsite parser ( unit )", () => {
  it("captureCallsite() returns a 'basename:line' string when called directly", () => {
    const cs = captureCallsite();
    expect(cs).to.match(/^callsite\.test\.ts:\d+$/);
  });
});

describe("callsite capture - gating ON ( layout uses ${callsite} )", () => {
  before(async () => {
    DI.clearCache();
    DI.register(CallsiteOnConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    // MemoryTarget is a @Singleton whose layout is fixed at first construction.
    // Construct/clear it with the SAME ${callsite} layout the config uses so the
    // logger's resolveLogTargets returns an instance whose layout triggers the
    // CaptureCallsite gate ( a config-driven FileTarget etc. gets this for free ).
    DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget", layout: "${message} @ ${callsite}" }]).clear();
  });

  it("flags CaptureCallsite = true when a target layout references ${callsite}", () => {
    const log = DI.resolve(Log, ["cs-flag"]);
    expect((log as any).CaptureCallsite).to.eq(true);
  });

  it("captures the caller's basename:line onto Variables.callsite", async () => {
    const log = DI.resolve(Log, ["cs-capture"]);
    const sink = DI.resolve(MemoryTarget, [MEMORY_TARGET]);

    await log.info("hello"); // <-- this is the call site we expect to capture

    const records = sink.getRecords();
    expect(records.length).to.eq(1);

    const callsite = records[0].Variables.callsite as string;
    expect(callsite).to.be.a("string").and.not.empty;
    // basename of THIS test file + the line of the log.info call above
    expect(callsite).to.match(/^callsite\.test\.ts:\d+$/);
  });

  it("${callsite} renders into a formatted layout line", async () => {
    const log = DI.resolve(Log, ["cs-render"]);
    const sink = DI.resolve(MemoryTarget, [MEMORY_TARGET]);

    await log.info("rendered");

    const entry = sink.getRecords()[0];
    // render the same layout the target is configured with
    const line = format(entry.Variables, "${message} @ ${callsite}");
    expect(line).to.match(/^rendered @ callsite\.test\.ts:\d+$/);
    expect(line).to.contain("@ callsite.test.ts:");
  });
});

describe("callsite capture - gating OFF ( no layout uses ${callsite} ) - zero-cost", () => {
  before(async () => {
    DI.clearCache();
    DI.register(CallsiteOffConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    DI.resolve(MemoryTarget, [MEMORY_TARGET]).clear();
  });

  it("flags CaptureCallsite = false when no target layout references ${callsite}", () => {
    const log = DI.resolve(Log, ["plain-flag"]);
    expect((log as any).CaptureCallsite).to.eq(false);
  });

  it("does NOT attach a callsite variable to emitted records", async () => {
    const log = DI.resolve(Log, ["plain-capture"]);
    const sink = DI.resolve(MemoryTarget, [MEMORY_TARGET]);

    await log.info("hello");

    const records = sink.getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.callsite).to.be.undefined;
  });

  it("does NOT construct any Error on the log path when capture is gated off", async () => {
    const log = DI.resolve(Log, ["plain-noerror"]);

    // Spy on Error construction: with gating off, wrapWrite never calls
    // captureCallsite ( the only `new Error()` on this path ) and no Error is
    // logged, so ZERO Errors are constructed - proving the zero-cost path.
    const OriginalError = global.Error;
    let constructed = 0;
    class SpyError extends OriginalError {
      constructor(...a: any[]) {
        super(...a);
        constructed++;
      }
    }
    (global as any).Error = SpyError;
    try {
      await log.info("plain message, no error");
    } finally {
      (global as any).Error = OriginalError;
    }

    expect(constructed).to.eq(0);
  });
});
