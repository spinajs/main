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

// dedicated config: a single Memory sink + opt-in whenRepeated with a long
// window so every same-message repeat lands inside it ( no real sleeping ).
class WhenRepeatedConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir("./../src/schemas")],
        },
      },
      logger: {
        whenRepeated: { timeout: 3600, maxKeys: 128 },
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

describe("whenRepeated wire-in", () => {
  before(async () => {
    DI.clearCache();
    DI.register(WhenRepeatedConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    // MemoryTarget is a @Singleton - clear it between tests
    DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]).clear();
  });

  it("collapses N identical repeats into a single emitted record", async () => {
    const log = DI.resolve(Log, ["wr-collapse"]);
    const sink = DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);

    for (let i = 0; i < 5; i++) {
      await log.info("boom");
    }

    const records = sink.getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.message).to.eq("boom");
  });

  it("keeps distinct messages as distinct records", async () => {
    const log = DI.resolve(Log, ["wr-distinct"]);
    const sink = DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);

    await log.info("alpha");
    await log.info("beta");
    await log.info("alpha");

    const records = sink.getRecords();
    // alpha, beta emit; the second alpha is inside the window so it is suppressed
    expect(records.length).to.eq(2);
    expect(records.map((r) => r.Variables.message)).to.deep.eq(["alpha", "beta"]);
  });
});
