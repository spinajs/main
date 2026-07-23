/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";
import { DI, NewInstance, Injectable } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
// side-effect import registers targets + filters ( MatchFilter, WhenRepeatedFilter ).
import { Log } from "../src/index.js";
import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// Per-instance recording target ( @NewInstance ) so distinct target NAMES resolve
// to distinct instances - required to prove per-target isolation.
@NewInstance()
@Injectable("TfrTarget")
export class TfrTarget extends LogTarget<ICommonTargetOptions> {
  public Records: ILogEntry[] = [];
  public write(data: ILogEntry): void {
    this.Records.push(data);
  }
}
void TfrTarget;

function targetsOf(log: Log): Array<{ instance: any; rule: any; ranges: any }> {
  return (log as any).Targets;
}

// ---------------------------------------------------------------------------
// Feature A: a rule with a level WINDOW ( level..maxLevel ).
// ---------------------------------------------------------------------------
class LevelRangeConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Mem", type: "TfrTarget" }],
        rules: [{ name: "*", level: "info", maxLevel: "warn", target: "Mem" }],
      },
    };
  }
}

describe("target-filters-ranges - level range ( maxLevel )", () => {
  before(async () => {
    DI.clearCache();
    DI.register(LevelRangeConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("delivers only entries inside [info, warn]; drops below and above", async () => {
    const log = DI.resolve(Log, ["lr-logger"]);
    const sink = targetsOf(log)[0].instance;

    await log.debug("dbg"); // below info -> dropped
    await log.success("ok"); // success (3) > warn? no: success=3, warn=4 -> in window? 2<=3<=4 -> kept
    await log.info("inf"); // in window -> kept
    await log.warn("wrn"); // at max -> kept
    await log.error("err"); // above warn -> dropped
    await log.fatal("ftl"); // above -> dropped

    const msgs = sink.Records.map((r: ILogEntry) => r.Variables.message);
    expect(msgs).to.deep.eq(["ok", "inf", "wrn"]);
  });
});

// ---------------------------------------------------------------------------
// Feature A: DISJOINT windows to the SAME target ( union, not a single min ).
// ---------------------------------------------------------------------------
class DisjointWindowsConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Mem", type: "TfrTarget" }],
        rules: [
          { name: "*", level: "info", maxLevel: "info", target: "Mem" },
          { name: "*", level: "error", maxLevel: "error", target: "Mem" },
        ],
      },
    };
  }
}

describe("target-filters-ranges - disjoint windows union", () => {
  before(async () => {
    DI.clearCache();
    DI.register(DisjointWindowsConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("info and error are delivered but warn ( between them ) is NOT", async () => {
    const log = DI.resolve(Log, ["dw-logger"]);
    const targets = targetsOf(log);
    // one collapsed descriptor carrying BOTH windows
    expect(targets.length).to.eq(1);
    expect(targets[0].ranges.length).to.eq(2);
    const sink = targets[0].instance;

    await log.info("i"); // in first window
    await log.warn("w"); // BETWEEN windows -> NOT delivered ( proves list, not single min )
    await log.error("e"); // in second window

    const msgs = sink.Records.map((r: ILogEntry) => r.Variables.message);
    expect(msgs).to.deep.eq(["i", "e"]);
  });
});

// ---------------------------------------------------------------------------
// Feature B: per-target filter isolation ( MatchFilter drop on ONE target only ).
// ---------------------------------------------------------------------------
class PerTargetFilterConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [
          { name: "Filtered", type: "TfrTarget", filters: [{ type: "MatchFilter", pattern: "secret", mode: "drop" }] },
          { name: "Plain", type: "TfrTarget" },
        ],
        rules: [{ name: "*", level: "trace", target: ["Filtered", "Plain"] }],
      },
    };
  }
}

describe("target-filters-ranges - per-target filter isolation", () => {
  before(async () => {
    DI.clearCache();
    DI.register(PerTargetFilterConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("a 'secret' entry is dropped for the filtered target only, delivered to the other", async () => {
    const log = DI.resolve(Log, ["ptf-logger"]);
    const targets = targetsOf(log);
    expect(targets.length).to.eq(2);
    const filtered = targets.find((t) => t.instance.Options.name === "Filtered")!.instance;
    const plain = targets.find((t) => t.instance.Options.name === "Plain")!.instance;

    await log.info("public info");
    await log.info("this is secret");

    const fMsgs = filtered.Records.map((r: ILogEntry) => r.Variables.message);
    const pMsgs = plain.Records.map((r: ILogEntry) => r.Variables.message);
    // filtered sink drops the secret one; plain sink receives BOTH
    expect(fMsgs).to.deep.eq(["public info"]);
    expect(pMsgs).to.deep.eq(["public info", "this is secret"]);
  });
});

// ---------------------------------------------------------------------------
// Feature B: per-target MUTATION isolation ( WhenRepeated's (xN) must not bleed ).
// ---------------------------------------------------------------------------
class PerTargetMutationConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [
          { name: "Collapsed", type: "TfrTarget", filters: [{ type: "WhenRepeatedFilter", timeout: 60 }] },
          { name: "Every", type: "TfrTarget" },
        ],
        rules: [{ name: "*", level: "trace", target: ["Collapsed", "Every"] }],
      },
    };
  }
}

describe("target-filters-ranges - per-target mutation isolation", () => {
  before(async () => {
    DI.clearCache();
    DI.register(PerTargetMutationConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("WhenRepeated collapses for ITS sink only; the other sink gets every UNMODIFIED entry", async () => {
    const log = DI.resolve(Log, ["ptm-logger"]);
    const targets = targetsOf(log);
    const collapsed = targets.find((t) => t.instance.Options.name === "Collapsed")!.instance;
    const every = targets.find((t) => t.instance.Options.name === "Every")!.instance;

    // Four IDENTICAL entries within the window. WhenRepeated ( per-target, its own
    // instance ) emits the 1st for the Collapsed sink and SUPPRESSES the rest.
    await log.info("boom");
    await log.info("boom");
    await log.info("boom");
    await log.info("boom");

    // Collapsed sink is COLLAPSED to a single "boom" ( repeats suppressed ).
    const cMsgs = collapsed.Records.map((r: ILogEntry) => r.Variables.message);
    expect(cMsgs).to.deep.eq(["boom"]);

    // Every sink: ALL four entries, each with an UNMODIFIED message. The Collapsed
    // sink's filter operated on a per-target CLONE, so neither suppression nor any
    // (xN) message mutation bled across to this sink.
    const eMsgs = every.Records.map((r: ILogEntry) => r.Variables.message);
    expect(eMsgs).to.deep.eq(["boom", "boom", "boom", "boom"]);
  });
});
