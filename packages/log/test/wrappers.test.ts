import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";
import { BlackHoleTarget } from "../src/targets/BlackHoleTarget.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// SplitGroupTarget fans one configured target out to two DIFFERENT inner types
// ( Memory + BlackHole ) so their @Singleton prototypes can be spied separately.
class SplitGroupConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir("./../src/schemas")],
        },
      },
      logger: {
        targets: [
          {
            name: "Split",
            type: "SplitGroupTarget",
            options: {
              targets: [
                { name: "Mem", type: "MemoryTarget" },
                { name: "Hole", type: "BlackHoleTarget" },
              ],
            },
          },
        ],
        rules: [{ name: "*", level: "trace", target: "Split" }],
      },
    };
  }
}

// AutoFlushTarget wrapping a single MemoryTarget with flushLevel error.
class AutoFlushConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir("./../src/schemas")],
        },
      },
      logger: {
        targets: [
          {
            name: "Auto",
            type: "AutoFlushTarget",
            options: {
              flushLevel: "error",
              target: { name: "Mem", type: "MemoryTarget" },
            },
          },
        ],
        rules: [{ name: "*", level: "trace", target: "Auto" }],
      },
    };
  }
}

describe("SplitGroupTarget fan-out", () => {
  let memWrite: sinon.SinonSpy;
  let holeWrite: sinon.SinonSpy;
  let memFlush: sinon.SinonSpy;
  let holeFlush: sinon.SinonSpy;

  before(async () => {
    DI.clearCache();
    DI.register(SplitGroupConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    memWrite = sinon.spy(MemoryTarget.prototype, "write");
    holeWrite = sinon.spy(BlackHoleTarget.prototype, "write");
    memFlush = sinon.spy(MemoryTarget.prototype, "forceFlush");
    holeFlush = sinon.spy(BlackHoleTarget.prototype, "forceFlush");
  });

  afterEach(() => {
    memWrite.restore();
    holeWrite.restore();
    memFlush.restore();
    holeFlush.restore();
  });

  it("routes one log entry to BOTH inner targets", async () => {
    const log = DI.resolve(Log, ["split-fanout"]);
    await log.info("hello %s", "world");

    expect(memWrite.callCount).to.eq(1);
    expect(holeWrite.callCount).to.eq(1);

    const memEntry = memWrite.firstCall.args[0];
    const holeEntry = holeWrite.firstCall.args[0];
    expect(memEntry.Variables.message).to.eq("hello world");
    // both children received the SAME entry
    expect(holeEntry).to.eq(memEntry);
  });

  it("forceFlush fans out to each inner target", async () => {
    DI.resolve(Log, ["split-flush"]);
    // resolve the wrapper instance and drain it
    const split = DI.resolve<any>("SplitGroupTarget", [{ name: "Split", type: "SplitGroupTarget", options: { targets: [] } }]);

    await split.forceFlush();

    expect(memFlush.callCount).to.eq(1);
    expect(holeFlush.callCount).to.eq(1);
  });
});

describe("AutoFlushTarget threshold", () => {
  let flushSpy: sinon.SinonSpy;
  let writeSpy: sinon.SinonSpy;

  before(async () => {
    DI.clearCache();
    DI.register(AutoFlushConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    writeSpy = sinon.spy(MemoryTarget.prototype, "write");
    flushSpy = sinon.spy(MemoryTarget.prototype, "forceFlush");
  });

  afterEach(() => {
    writeSpy.restore();
    flushSpy.restore();
  });

  it("does NOT flush inner on a below-threshold entry", async () => {
    const log = DI.resolve(Log, ["auto-info"]);
    await log.info("just info");

    expect(writeSpy.callCount).to.eq(1);
    expect(flushSpy.callCount).to.eq(0);
  });

  it("flushes inner once on an at-threshold entry", async () => {
    const log = DI.resolve(Log, ["auto-error"]);
    await log.error(new Error("boom"), "crash");

    expect(writeSpy.callCount).to.eq(1);
    expect(flushSpy.callCount).to.eq(1);
  });
});
