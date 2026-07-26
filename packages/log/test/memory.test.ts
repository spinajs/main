import "mocha";
import { expect } from "chai";
import { ILogEntry, LogLevel } from "@spinajs/log-common";
import { MemoryTarget, IMemoryTargetOptions } from "../src/targets/MemoryTarget.js";

function entry(id: number): ILogEntry {
  return {
    Level: LogLevel.Info,
    Variables: {
      message: `msg-${id}`,
      id,
    } as any,
  };
}

function makeTarget(options?: Partial<IMemoryTargetOptions>): MemoryTarget {
  // pass a full-ish options object; base LogTarget merges layout/enabled defaults
  return new MemoryTarget({
    name: "memory",
    type: "MemoryTarget",
    ...options,
  } as IMemoryTargetOptions);
}

describe("MemoryTarget", () => {
  it("defaults limit to 100 when not provided", () => {
    const target = makeTarget();
    expect((target.Options as IMemoryTargetOptions).limit).to.eq(100);
  });

  it("retains only the newest `limit` entries ( ring buffer )", () => {
    const limit = 5;
    const total = limit + 50;
    const target = makeTarget({ limit });

    for (let i = 0; i < total; i++) {
      target.write(entry(i));
    }

    const records = target.getRecords();
    expect(records.length).to.eq(limit);

    // newest entry ( last written ) must be present
    expect(records[records.length - 1].Variables.id).to.eq(total - 1);
    // oldest entries must have been dropped
    expect(records[0].Variables.id).to.eq(total - limit);
    expect(records.some((r) => r.Variables.id === 0)).to.eq(false);
  });

  it("getRecords returns a shallow copy that cannot mutate the ring", () => {
    const target = makeTarget({ limit: 3 });
    target.write(entry(1));

    const records = target.getRecords();
    records.push(entry(999));

    expect(target.getRecords().length).to.eq(1);
  });

  it("clear() empties the buffer", () => {
    const target = makeTarget({ limit: 5 });
    target.write(entry(1));
    target.write(entry(2));
    expect(target.getRecords().length).to.eq(2);

    target.clear();
    expect(target.getRecords().length).to.eq(0);
  });

  it("write is a no-op when disabled", () => {
    const target = makeTarget({ limit: 5, enabled: false });
    target.write(entry(1));
    target.write(entry(2));
    expect(target.getRecords().length).to.eq(0);
  });
});
