/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";
import { DI, Injectable, Singleton } from "@spinajs/di";
import { ICommonTargetOptions, ILogEntry, LogLevel, LogTarget } from "../src/index.js";
import { RetryingTarget } from "../src/targets/wrappers/RetryingTarget.js";
import { FallbackGroupTarget } from "../src/targets/wrappers/FallbackGroupTarget.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

function entry(msg: string): ILogEntry {
  return { Level: LogLevel.Info, Variables: { logger: "t", level: "INFO", message: msg } } as ILogEntry;
}

/**
 * Stub inner target whose write REJECTS the first `failFirst` calls, then
 * resolves. Counts total calls. Registered under a distinct DI name so
 * RetryingTarget can resolve it.
 */
@Singleton()
@Injectable("FlakyThenOkTarget")
class FlakyThenOkTarget extends LogTarget<ICommonTargetOptions> {
  public static Calls = 0;
  public static FailFirst = 2;

  public write(): Promise<void> {
    FlakyThenOkTarget.Calls++;
    if (FlakyThenOkTarget.Calls <= FlakyThenOkTarget.FailFirst) {
      return Promise.reject(new Error(`stub reject #${FlakyThenOkTarget.Calls}`));
    }
    return Promise.resolve();
  }
}

/** Stub inner target whose write ALWAYS rejects. Counts calls. */
@Singleton()
@Injectable("AlwaysRejectTarget")
class AlwaysRejectTarget extends LogTarget<ICommonTargetOptions> {
  public static Calls = 0;

  public write(): Promise<void> {
    AlwaysRejectTarget.Calls++;
    return Promise.reject(new Error("always down"));
  }
}

/**
 * Stub PRIMARY that RESOLVES its write but simulates a self-healing target that
 * later GIVES UP: it calls OnDropped for the entry ( mechanism D ). Records the
 * entries it "accepted".
 */
@Singleton()
@Injectable("GiveUpPrimaryTarget")
class GiveUpPrimaryTarget extends LogTarget<ICommonTargetOptions> {
  public Accepted: ILogEntry[] = [];

  public write(entry: ILogEntry): Promise<void> {
    this.Accepted.push(entry);
    // simulate a later async give-up ( eg. non-retryable delivery failure ):
    // spill the entry to whatever fallback the wrapper wired.
    this.OnDropped?.(entry);
    return Promise.resolve();
  }
}

// Stub targets are registered purely via the @Injectable decorator side-effect
// and resolved by DI string name; reference them so the classes are retained
// ( and the decorators run ) and TS does not flag them as unused.
void [FlakyThenOkTarget, AlwaysRejectTarget, GiveUpPrimaryTarget, MemoryTarget];

describe("RetryingTarget ( mechanism A / retry )", () => {
  beforeEach(() => {
    DI.clearCache();
    FlakyThenOkTarget.Calls = 0;
    FlakyThenOkTarget.FailFirst = 2;
    AlwaysRejectTarget.Calls = 0;
  });

  it("retries an inner write that rejects the first 2 calls then resolves", async () => {
    const target = DI.resolve<RetryingTarget>("RetryingTarget", [
      {
        name: "Retry",
        type: "RetryingTarget",
        options: { target: { name: "Flaky", type: "FlakyThenOkTarget" }, maxAttempts: 3, delayMs: 1 },
      },
    ]);

    // resolves ( no throw ) once the 3rd attempt succeeds
    await target.write(entry("hello"));

    expect(FlakyThenOkTarget.Calls).to.eq(3);
  });

  it("rejects after maxAttempts when the inner write ALWAYS rejects", async () => {
    const target = DI.resolve<RetryingTarget>("RetryingTarget", [
      {
        name: "Retry",
        type: "RetryingTarget",
        options: { target: { name: "Always", type: "AlwaysRejectTarget" }, maxAttempts: 3, delayMs: 1 },
      },
    ]);

    let rejected = false;
    try {
      await target.write(entry("nope"));
    } catch {
      rejected = true;
    }

    expect(rejected).to.eq(true);
    // 3 total attempts = first try + 2 retries
    expect(AlwaysRejectTarget.Calls).to.eq(3);
  });
});

describe("FallbackGroupTarget ( mechanism A / fallback )", () => {
  beforeEach(() => {
    DI.clearCache();
    AlwaysRejectTarget.Calls = 0;
  });

  it("advances to the fallback when the primary write rejects", async () => {
    const target = DI.resolve<FallbackGroupTarget>("FallbackGroupTarget", [
      {
        name: "Fallback",
        type: "FallbackGroupTarget",
        options: {
          targets: [
            { name: "Primary", type: "AlwaysRejectTarget" },
            { name: "Mem", type: "MemoryTarget" },
          ],
        },
      },
    ]);

    const e = entry("survives failover");
    await target.write(e);

    // primary was tried ( and rejected )
    expect(AlwaysRejectTarget.Calls).to.eq(1);

    // the MemoryTarget ( fallback ) received the entry
    const mem = DI.resolve<MemoryTarget>("MemoryTarget", [{ name: "Mem", type: "MemoryTarget" }]);
    const records = mem.getRecords();
    expect(records).to.have.length(1);
    expect(records[0].Variables.message).to.eq("survives failover");
  });
});

describe("FallbackGroupTarget ( mechanism D / drop-hook )", () => {
  beforeEach(() => {
    DI.clearCache();
  });

  it("routes an entry the primary GIVES UP on to the fallback via OnDropped", async () => {
    const target = DI.resolve<FallbackGroupTarget>("FallbackGroupTarget", [
      {
        name: "Fallback",
        type: "FallbackGroupTarget",
        options: {
          targets: [
            { name: "GiveUp", type: "GiveUpPrimaryTarget" },
            { name: "Mem", type: "MemoryTarget" },
          ],
        },
      },
    ]);

    const e = entry("dropped but caught");
    await target.write(e);

    // the fallback caught exactly the dropped entry via the OnDropped hook
    const mem = DI.resolve<MemoryTarget>("MemoryTarget", [{ name: "Mem", type: "MemoryTarget" }]);
    const records = mem.getRecords();
    expect(records).to.have.length(1);
    expect(records[0]).to.eq(e);
  });
});
