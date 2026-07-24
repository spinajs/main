import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
// side-effect import registers all targets + filters ( LevelFilter, MatchFilter,
// RateLimitFilter, WhenRepeatedFilter ) under their DI string names.
import { Log } from "../src/index.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// A logger with a filter pipeline: level gate ( warn+ ) then a drop-on-match
// filter. Routed to a single Memory sink.
class FiltersPipelineConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir("./../src/schemas")],
        },
      },
      logger: {
        filters: [
          { type: "LevelFilter", min: "warn" },
          { type: "MatchFilter", pattern: "drop-me", mode: "drop" },
        ],
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

describe("filter pipeline wire-in", () => {
  before(async () => {
    DI.clearCache();
    DI.register(FiltersPipelineConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]).clear();
  });

  it("applies the configured filters IN ORDER; only the kept entry lands", async () => {
    const log = DI.resolve(Log, ["fp-order"]);
    const sink = DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);

    await log.debug("debug-line"); // dropped by LevelFilter ( below warn )
    await log.warn("keep"); // passes both filters
    await log.warn("drop-me now"); // dropped by MatchFilter ( drop mode )

    const records = sink.getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.message).to.eq("keep");
  });
});

// A separate config exercising backward compat: legacy logger.whenRepeated still
// suppresses repeats ( mapped to a prepended WhenRepeatedFilter ).
class WhenRepeatedCompatConfiguration extends FrameworkConfiguration {
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

describe("filter pipeline backward compat ( whenRepeated )", () => {
  before(async () => {
    DI.clearCache();
    DI.register(WhenRepeatedCompatConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]).clear();
  });

  it("legacy logger.whenRepeated still collapses identical repeats", async () => {
    const log = DI.resolve(Log, ["fp-compat"]);
    const sink = DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);

    for (let i = 0; i < 5; i++) {
      await log.info("boom");
    }

    const records = sink.getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.message).to.eq("boom");
  });
});
