/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { DI, NewInstance, Injectable } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";
import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";
import { InvalidOption } from "@spinajs/exceptions";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

function targetsOf(log: Log): Array<{ instance: any; rule: any }> {
  return (log as any).Targets;
}

// A stub buffered target: records entries and exposes a spy-able forceFlush so
// tests can assert flush() drains it. @NewInstance so distinct names -> distinct
// instances.
let constructedSpy = 0;
@NewInstance()
@Injectable("BufferTarget")
export class BufferTarget extends LogTarget<ICommonTargetOptions> {
  public Records: ILogEntry[] = [];
  public FlushCount = 0;
  constructor(options: ICommonTargetOptions) {
    super(options);
  }
  public write(data: ILogEntry): void {
    this.Records.push(data);
  }
  public forceFlush(): Promise<void> {
    this.FlushCount++;
    return Promise.resolve();
  }
}
void BufferTarget;

// A target whose construction is counted so a disabled config can prove its
// class is NEVER instantiated.
@NewInstance()
@Injectable("SpyTarget")
export class SpyTarget extends LogTarget<ICommonTargetOptions> {
  constructor(options: ICommonTargetOptions) {
    super(options);
    constructedSpy++;
  }
  public write(): void {
    /* noop */
  }
}
void SpyTarget;

// ---------------------------------------------------------------------------
// Feature 1: disabled targets are not instantiated / not routed.
// ---------------------------------------------------------------------------
class DisabledTargetConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [
          { name: "On", type: "BufferTarget" },
          { name: "Off", type: "SpyTarget", enabled: false },
        ],
        rules: [
          { name: "mix-*", level: "trace", target: ["On", "Off"] },
          { name: "onlyoff-*", level: "trace", target: "Off" },
        ],
      },
    };
  }
}

describe("lifecycle - disabled targets are not instantiated", () => {
  before(async () => {
    DI.clearCache();
    DI.register(DisabledTargetConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    constructedSpy = 0;
  });

  it("skips an enabled:false target ( not in Targets, class never constructed )", () => {
    const log = DI.resolve(Log, ["mix-logger"]);
    const targets = targetsOf(log);
    // only the enabled "On" target is routed
    expect(targets.length).to.eq(1);
    expect(targets[0].rule.target).to.deep.eq(["On", "Off"]);
    expect(targets.map((t) => t.instance.constructor.name)).to.deep.eq(["BufferTarget"]);
    // the disabled SpyTarget class was never constructed
    expect(constructedSpy).to.eq(0);
  });

  it("a rule referencing ONLY disabled targets is skipped ( no Targets, no throw )", () => {
    const log = DI.resolve(Log, ["onlyoff-logger"]);
    const targets = targetsOf(log);
    expect(targets.length).to.eq(0);
    expect(constructedSpy).to.eq(0);
  });
});

// A rule referencing a target NAME that does not exist AT ALL still throws.
class MissingNameConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Off", type: "SpyTarget", enabled: false }],
        rules: [{ name: "*", level: "trace", target: "DoesNotExist" }],
      },
    };
  }
}

describe("lifecycle - missing target name still throws ( vs disabled skip )", () => {
  before(async () => {
    DI.clearCache();
    DI.register(MissingNameConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("throws InvalidOption for a truly missing target name", () => {
    let err: any = null;
    try {
      DI.resolve(Log, ["missing-name-logger"]);
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
// Feature 2: flush / flushAll / clearLoggers drain buffered targets.
// ---------------------------------------------------------------------------
class FlushConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Buf", type: "BufferTarget" }],
        rules: [{ name: "flush-*", level: "trace", target: "Buf" }],
      },
    };
  }
}

describe("lifecycle - flush / flushAll / clearLoggers", () => {
  before(async () => {
    DI.clearCache();
    DI.register(FlushConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("log.flush() calls forceFlush on the logger's targets", async () => {
    const log = DI.resolve(Log, ["flush-one"]);
    const target = targetsOf(log)[0].instance as BufferTarget;
    const spy = sinon.spy(target, "forceFlush");

    await log.flush();

    expect(spy.calledOnce).to.eq(true);
    spy.restore();
  });

  it("Log.flushAll() flushes across all registered loggers", async () => {
    const a = DI.resolve(Log, ["flush-a"]);
    const b = DI.resolve(Log, ["flush-b"]);
    const spyA = sinon.spy(targetsOf(a)[0].instance as BufferTarget, "forceFlush");
    const spyB = sinon.spy(targetsOf(b)[0].instance as BufferTarget, "forceFlush");

    await Log.flushAll();

    expect(spyA.calledOnce).to.eq(true);
    expect(spyB.calledOnce).to.eq(true);
    spyA.restore();
    spyB.restore();
  });

  it("Log.clearLoggers() flushes targets BEFORE disposing loggers", async () => {
    const log = DI.resolve(Log, ["flush-clear"]);
    const spy = sinon.spy(targetsOf(log)[0].instance as BufferTarget, "forceFlush");

    await Log.clearLoggers();

    expect(spy.calledOnce).to.eq(true);
    spy.restore();
  });

  it("flush() on a logger with no resolved targets is a safe no-op", async () => {
    const log = DI.resolve(Log, ["flush-empty"]) as any;
    log.Targets = undefined;
    // must not throw
    await log.flush();
  });
});
