/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";
import { DI, NewInstance, Injectable } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";
import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";
import { InvalidOption } from "@spinajs/exceptions";
import { RateLimitFilter } from "../src/filters/RateLimitFilter.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// A per-instance recording target. Unlike MemoryTarget ( a @Singleton, one
// instance process-wide ), this is @NewInstance so two DISTINCT target names in
// a config resolve to DISTINCT instances - which is exactly what BUG 2's
// "no over-collapse" negative case needs.
@NewInstance()
@Injectable("RecTarget")
export class RecTarget extends LogTarget<ICommonTargetOptions> {
  public Records: ILogEntry[] = [];
  public write(data: ILogEntry): void {
    this.Records.push(data);
  }
}

// keep a live reference so the side-effect-registered class isn't tree-shaken /
// flagged as unused ( it is resolved by its DI string name "RecTarget" ).
void RecTarget;

function targetsOf(log: Log): Array<{ instance: any; rule: any }> {
  return (log as any).Targets;
}

// ---------------------------------------------------------------------------
// BUG 2: two rules routing to the SAME target -> one record, not two.
// ---------------------------------------------------------------------------
class SameTargetDupConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Rec", type: "RecTarget" }],
        // BOTH rules match the "dup-*" logger and BOTH route to "Rec".
        rules: [
          { name: "dup-*", level: "trace", target: "Rec" },
          { name: "dup-logger", level: "info", target: "Rec" },
        ],
      },
    };
  }
}

describe("routing - BUG 2 same-target de-dup", () => {
  before(async () => {
    DI.clearCache();
    DI.register(SameTargetDupConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("two matched rules routing to the same target yield exactly ONE record", async () => {
    const log = DI.resolve(Log, ["dup-logger"]);
    const targets = targetsOf(log);
    // de-duped to a single descriptor for the shared instance
    expect(targets.length).to.eq(1);

    await log.info("hello");
    expect(targets[0].instance.Records.length).to.eq(1);
  });

  it("keeps the MOST PERMISSIVE ( lowest ) rule level for the collapsed target", async () => {
    const log = DI.resolve(Log, ["dup-logger"]);
    const targets = targetsOf(log);
    // one rule was info, one trace -> the kept descriptor must carry trace
    expect(targets.length).to.eq(1);
    expect(targets[0].rule.level).to.eq("trace");

    // a debug entry ( below info, above trace ) is still delivered ONCE
    await log.debug("dbg");
    expect(targets[0].instance.Records.length).to.eq(1);
    expect(targets[0].instance.Records[0].Variables.message).to.eq("dbg");
  });
});

// ---------------------------------------------------------------------------
// BUG 2 min-level boundary: an entry below BOTH levels is dropped.
// ---------------------------------------------------------------------------
class MinLevelBoundaryConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Rec", type: "RecTarget" }],
        rules: [
          { name: "bnd-*", level: "info", target: "Rec" },
          { name: "bnd-logger", level: "warn", target: "Rec" },
        ],
      },
    };
  }
}

describe("routing - BUG 2 collapsed min-level boundary", () => {
  before(async () => {
    DI.clearCache();
    DI.register(MinLevelBoundaryConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("delivers at the min ( info ) level and drops entries below it", async () => {
    const log = DI.resolve(Log, ["bnd-logger"]);
    const targets = targetsOf(log);
    expect(targets.length).to.eq(1);
    expect(targets[0].rule.level).to.eq("info"); // min of info/warn

    await log.debug("below"); // below info -> dropped
    await log.info("at-min"); // at min -> kept once
    const recs = targets[0].instance.Records;
    expect(recs.length).to.eq(1);
    expect(recs[0].Variables.message).to.eq("at-min");
  });
});

// ---------------------------------------------------------------------------
// BUG 2 negative: two rules -> two DISTINCT targets, each gets the entry once.
// ---------------------------------------------------------------------------
class DistinctTargetsConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [
          { name: "RecA", type: "RecTarget" },
          { name: "RecB", type: "RecTarget" },
        ],
        rules: [
          { name: "two-*", level: "trace", target: "RecA" },
          { name: "two-logger", level: "trace", target: "RecB" },
        ],
      },
    };
  }
}

describe("routing - BUG 2 negative ( distinct targets not over-collapsed )", () => {
  before(async () => {
    DI.clearCache();
    DI.register(DistinctTargetsConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("two rules to two distinct targets each receive the entry exactly once", async () => {
    const log = DI.resolve(Log, ["two-logger"]);
    const targets = targetsOf(log);
    // two DISTINCT instances -> two descriptors kept
    expect(targets.length).to.eq(2);
    expect(targets[0].instance).to.not.eq(targets[1].instance);

    await log.info("fanned");
    expect(targets[0].instance.Records.length).to.eq(1);
    expect(targets[1].instance.Records.length).to.eq(1);
  });
});

// ---------------------------------------------------------------------------
// BUG 3: a rule referencing a non-existent target fails fast.
// ---------------------------------------------------------------------------
class MissingTargetConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Rec", type: "RecTarget" }],
        rules: [{ name: "*", level: "trace", target: "DoesNotExist" }],
      },
    };
  }
}

describe("routing - BUG 3 missing-target validation", () => {
  before(async () => {
    DI.clearCache();
    DI.register(MissingTargetConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("throws InvalidOption ( with a helpful message ) when a rule names a missing target", () => {
    let err: any = null;
    try {
      DI.resolve(Log, ["missing-target-logger"]);
    } catch (e) {
      err = e;
    }
    expect(err, "expected resolve to throw").to.not.be.null;
    expect(err).to.be.instanceOf(InvalidOption);
    expect(err.message).to.contain("No target matching rule");
    expect(err.message).to.contain("DoesNotExist");
  });
});

// ---------------------------------------------------------------------------
// Footgun fix: ordered ADDITIVE rule matching + the `final` flag.
// A logger with its OWN specific rule now ALSO reaches the `*` catch-all target
// ( the old "specific rule drops `*`" behavior silently excluded it ), unless a
// `final: true` rule short-circuits later rules.
// ---------------------------------------------------------------------------
class AdditiveRulesConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [
          { name: "Catch", type: "RecTarget" }, // the `*` catch-all sink
          { name: "Pool", type: "RecTarget" }, // db.pool's dedicated sink
        ],
        rules: [
          // additive: db.pool matches BOTH `*` ( Catch ) and its own rule ( Pool )
          { name: "*", level: "trace", target: "Catch" },
          { name: "db.pool", level: "trace", target: "Pool" },
          // final: db.final matches its own rule ( marked final, placed BEFORE the
          // catch-all effect ) - but note `*` is EARLIER here so it still applies.
        ],
      },
    };
  }
}

describe("routing - additive rule matching ( footgun fix )", () => {
  before(async () => {
    DI.clearCache();
    DI.register(AdditiveRulesConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("a logger with its OWN specific rule ALSO reaches the '*' catch-all target", async () => {
    const log = DI.resolve(Log, ["db.pool"]);
    const targets = targetsOf(log);
    // additive: BOTH Catch ( from `*` ) and Pool ( from db.pool ) are routed to
    expect(targets.length).to.eq(2);

    await log.info("hello");
    // proof: the entry landed in the catch-all sink too, not only the specific one
    const records = targets.map((t) => t.instance.Records.length);
    expect(records).to.deep.eq([1, 1]);
  });

  it("a logger matched ONLY by '*' reaches just the catch-all", async () => {
    const log = DI.resolve(Log, ["unrelated"]);
    const targets = targetsOf(log);
    expect(targets.length).to.eq(1);

    await log.info("hi");
    expect(targets[0].instance.Records.length).to.eq(1);
  });
});

// A `final: true` specific rule placed BEFORE the `*` catch-all short-circuits it,
// restoring this-rule-only routing ( while non-matching loggers still fall through ).
class FinalRuleConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [
          { name: "Catch", type: "RecTarget" },
          { name: "Pool", type: "RecTarget" },
        ],
        rules: [
          { name: "db.pool", level: "trace", target: "Pool", final: true },
          { name: "*", level: "trace", target: "Catch" },
        ],
      },
    };
  }
}

describe("routing - `final` short-circuits later rules", () => {
  before(async () => {
    DI.clearCache();
    DI.register(FinalRuleConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("a final specific rule before '*' routes ONLY to its own target", async () => {
    const log = DI.resolve(Log, ["db.pool"]);
    const targets = targetsOf(log);
    // the final db.pool rule stops evaluation, so the later '*' ( Catch ) is skipped
    expect(targets.length).to.eq(1);

    await log.info("only-pool");
    expect(targets[0].instance.Records.length).to.eq(1);
    expect(targets[0].instance.Records[0].Variables.message).to.eq("only-pool");
  });

  it("a NON-matching logger still falls through to the '*' catch-all", async () => {
    const log = DI.resolve(Log, ["other"]);
    const targets = targetsOf(log);
    expect(targets.length).to.eq(1);

    await log.info("caught");
    expect(targets[0].instance.Records.length).to.eq(1);
  });
});

// ---------------------------------------------------------------------------
// BUG 1: filters are @NewInstance -> distinct instances + independent state.
// ---------------------------------------------------------------------------
describe("routing - BUG 1 filters are per-instance ( @NewInstance )", () => {
  before(() => {
    DI.clearCache();
  });

  it("DI.resolve('RateLimitFilter', [opts]) twice yields DISTINCT instances", () => {
    const a = DI.resolve<RateLimitFilter>("RateLimitFilter", [{ type: "RateLimitFilter", limit: 5, intervalSeconds: 60 }]);
    const b = DI.resolve<RateLimitFilter>("RateLimitFilter", [{ type: "RateLimitFilter", limit: 5, intervalSeconds: 60 }]);
    expect(a).to.not.eq(b);
  });

  it("two filters get their OWN options and independent state", () => {
    let clock = 0;
    const now = () => clock;

    // two filters with DIFFERENT limits, injected clock frozen inside one window
    const f1 = DI.resolve<RateLimitFilter>("RateLimitFilter", [{ type: "RateLimitFilter", limit: 2, intervalSeconds: 60 }, now]);
    const f2 = DI.resolve<RateLimitFilter>("RateLimitFilter", [{ type: "RateLimitFilter", limit: 1, intervalSeconds: 60 }, now]);
    expect(f1).to.not.eq(f2);

    const entry = () => ({ Level: 3, Variables: { message: "m", logger: "x" } }) as unknown as ILogEntry;

    // f1 ( limit 2 ): keeps 2, drops the 3rd
    expect(f1.apply(entry())).to.not.be.null;
    expect(f1.apply(entry())).to.not.be.null;
    expect(f1.apply(entry())).to.be.null;

    // f2 ( limit 1 ) is UNAFFECTED by f1 consuming its budget: keeps 1, drops 2nd.
    // Proves independent per-instance state and its OWN ( different ) limit option.
    expect(f2.apply(entry())).to.not.be.null;
    expect(f2.apply(entry())).to.be.null;
  });
});
