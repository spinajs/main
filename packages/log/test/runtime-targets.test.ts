/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";
import { DI, NewInstance, Injectable } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
// side-effect import registers the built-in targets ( MemoryTarget, etc. ).
import { Log } from "../src/index.js";
import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// A per-instance recording target ( @NewInstance ) so each distinct target NAME
// resolves to its OWN instance - the runtime add/remove tests need a SECOND,
// distinct in-memory sink ( MemoryTarget is a @Singleton and would be shared ).
// Also tracks forceFlush() calls so removeTarget's drain can be asserted.
@NewInstance()
@Injectable("RtTarget")
export class RtTarget extends LogTarget<ICommonTargetOptions> {
  public Records: ILogEntry[] = [];
  public FlushCount = 0;
  public write(data: ILogEntry): void {
    this.Records.push(data);
  }
  public forceFlush(): Promise<void> {
    this.FlushCount++;
    return Promise.resolve();
  }
}
void RtTarget;

// A second recording target whose default layout references ${callsite}, to
// prove the CaptureCallsite gate flips when it is the only such target and is
// then removed.
@NewInstance()
@Injectable("RtCallsiteTarget")
export class RtCallsiteTarget extends LogTarget<ICommonTargetOptions> {
  public Records: ILogEntry[] = [];
  constructor(options: any) {
    super({ layout: "${callsite} ${message}", ...options });
  }
  public write(data: ILogEntry): void {
    this.Records.push(data);
  }
}
void RtCallsiteTarget;

function targetsOf(log: Log): Array<{ instance: any; options: any; ranges: any }> {
  return (log as any).Targets;
}

// Base config: one MemoryTarget-backed logger via our recording target so the
// starting state is a single, known sink.
class RuntimeTargetsConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Base", type: "RtTarget" }],
        rules: [{ name: "*", level: "trace", target: "Base" }],
      },
    };
  }
}

describe("runtime targets - addTarget / removeTarget", () => {
  before(async () => {
    DI.clearCache();
    DI.register(RuntimeTargetsConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("addTarget attaches a sink at runtime and returns the resolved instance", async () => {
    const log = DI.resolve(Log, ["rt-add"]);

    const t = log.addTarget({ name: "Extra", type: "RtTarget" });
    expect(t).to.not.eq(undefined);

    // the return value is the instance now present in the descriptor set
    const desc = targetsOf(log).find((d) => d.options?.name === "Extra");
    expect(desc).to.not.eq(undefined);
    expect(desc!.instance).to.eq(t);

    await log.info("hello");

    expect((t as any).Records.map((r: ILogEntry) => r.Variables.message)).to.deep.eq(["hello"]);
  });

  it("addTarget honors a level window ( info dropped below warn, warn kept )", async () => {
    const log = DI.resolve(Log, ["rt-window"]);

    const t = log.addTarget({ name: "Warns", type: "RtTarget" }, { level: "warn" })!;

    await log.info("inf"); // below warn -> not delivered to this target
    await log.warn("wrn"); // at warn -> delivered

    expect((t as any).Records.map((r: ILogEntry) => r.Variables.message)).to.deep.eq(["wrn"]);
  });

  it("removeTarget flushes then detaches ( no further writes, forceFlush called )", async () => {
    const log = DI.resolve(Log, ["rt-remove"]);

    const t = log.addTarget({ name: "Extra", type: "RtTarget" })!;

    await log.info("before");
    expect((t as any).Records.length).to.eq(1);

    await log.removeTarget("Extra");

    // drained during removal
    expect((t as any).FlushCount).to.be.greaterThan(0);
    // no longer in the descriptor set
    expect(targetsOf(log).some((d) => d.options?.name === "Extra")).to.eq(false);

    await log.info("after");
    // still only the entry written before removal
    expect((t as any).Records.map((r: ILogEntry) => r.Variables.message)).to.deep.eq(["before"]);
  });

  it("addTarget with enabled:false returns undefined and attaches nothing", async () => {
    const log = DI.resolve(Log, ["rt-disabled"]);
    const before = targetsOf(log).length;

    const t = log.addTarget({ name: "X", type: "RtTarget", enabled: false });

    expect(t).to.eq(undefined);
    expect(targetsOf(log).length).to.eq(before);
  });

  it("adding the same name twice replaces ( no duplicate descriptor / writes )", async () => {
    const log = DI.resolve(Log, ["rt-replace"]);

    log.addTarget({ name: "Extra", type: "RtTarget" });
    const second = log.addTarget({ name: "Extra", type: "RtTarget" })!;

    const matching = targetsOf(log).filter((d) => d.options?.name === "Extra");
    expect(matching.length).to.eq(1);

    await log.info("once");
    // only the surviving ( second ) instance received it, exactly once
    expect((second as any).Records.map((r: ILogEntry) => r.Variables.message)).to.deep.eq(["once"]);
  });

  it("recomputes the ${callsite} gate and MinLevel when targets change", async () => {
    const log = DI.resolve(Log, ["rt-gates"]);

    // base RtTarget layout has no ${callsite}
    expect((log as any).CaptureCallsite).to.eq(false);

    // attach a callsite-using target -> gate turns on
    log.addTarget({ name: "CS", type: "RtCallsiteTarget" });
    expect((log as any).CaptureCallsite).to.eq(true);

    // MinLevel reflects the union: base is trace(0), add a warn-only target does
    // not raise the floor below trace.
    expect((log as any).MinLevel).to.eq(0);

    // remove the only ${callsite} target -> gate turns back off
    await log.removeTarget("CS");
    expect((log as any).CaptureCallsite).to.eq(false);

    // remove the base target too -> no targets -> MinLevel floors at Trace(0)
    await log.removeTarget("Base");
    expect((log as any).MinLevel).to.eq(0);
    expect(targetsOf(log).length).to.eq(0);
  });

  it("opts.filters are merged onto the target ( appended after def.filters )", async () => {
    const log = DI.resolve(Log, ["rt-filters"]);

    // MatchFilter drops entries matching /secret/ for this target only
    const t = log.addTarget({ name: "Filtered", type: "RtTarget" }, { filters: [{ type: "MatchFilter", pattern: "secret", mode: "drop" } as any] })!;

    await log.info("keep me");
    await log.info("a secret value");

    expect((t as any).Records.map((r: ILogEntry) => r.Variables.message)).to.deep.eq(["keep me"]);
  });
});
