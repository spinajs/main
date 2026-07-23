import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// dedicated config: a single Memory sink capturing every level so we can read
// the entry Variables back and assert on the merging-object dispatch.
class MergingObjectConfiguration extends FrameworkConfiguration {
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
            name: "Memory",
            type: "MemoryTarget",
          },
        ],
        rules: [{ name: "*", level: "trace", target: "Memory" }],
      },
    };
  }
}

describe("merging-object first argument", () => {
  before(async () => {
    DI.clearCache();
    DI.register(MergingObjectConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    // MemoryTarget is a @Singleton - clear it between tests
    DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]).clear();
  });

  function sink(): MemoryTarget {
    return DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);
  }

  it("merges fields into Variables and formats the message string", async () => {
    const log = DI.resolve(Log, ["mo-fields"]);
    await log.info({ reqId: "abc", sku: "A-1" }, "checkout %s", "started");

    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.reqId).to.eq("abc");
    expect(records[0].Variables.sku).to.eq("A-1");
    expect(records[0].Variables.message).to.eq("checkout started");
  });

  it("object-only call yields an empty message and merges fields", async () => {
    const log = DI.resolve(Log, ["mo-object-only"]);
    await log.info({ a: 1 });

    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.a).to.eq(1);
    expect(records[0].Variables.message).to.eq("");
  });

  it("REGRESSION: Error-first call is unchanged", async () => {
    const log = DI.resolve(Log, ["mo-error"]);
    await log.error(new Error("boom"), "user msg");

    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    const err = records[0].Variables.error as any;
    expect(err).to.not.be.undefined;
    expect(err.message).to.eq("boom");
    expect(records[0].Variables.message).to.contain("user msg");
  });

  it("REGRESSION: string-first call is unchanged and leaks no stray keys", async () => {
    const log = DI.resolve(Log, ["mo-string"]);
    await log.info("hello %s", "world");

    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.message).to.eq("hello world");

    // only the standard static variables ( error, level, logger, message ) should
    // be present - no stray field keys from a mis-parsed object form.
    const keys = Object.keys(records[0].Variables).sort();
    expect(keys).to.deep.eq(["error", "level", "logger", "message"]);
  });
});
