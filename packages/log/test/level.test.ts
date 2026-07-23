/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { LogLevel, Log, normalizeLevel, readPersistedLevel, clearPersistedLevel } from "../src/index.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

// Dedicated config: a single MemoryTarget sink capturing every level ( rule
// level trace => MinLevel = Trace ) so we can assert on gating.
class LevelConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
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

function logger(name = "level-test"): Log {
  return DI.resolve(Log, [name]) as Log;
}

function memoryTarget(log: Log): MemoryTarget {
  // the resolved logger keeps its targets under `Targets`
  const targets = (log as any).Targets as Array<{ instance: MemoryTarget }>;
  return targets[0].instance;
}

describe("runtime log level control", () => {
  before(async () => {
    DI.clearCache();
    DI.register(LevelConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  it("getLevel() defaults to the rule-derived MinLevel ( trace )", () => {
    const log = logger();
    expect(log.getLevel()).to.eq(LogLevel.Trace);
  });

  it("setLevel('error') gates debug/info but lets error through", async () => {
    const log = logger();
    const target = memoryTarget(log);
    target.clear();

    log.setLevel("error", false);
    expect(log.getLevel()).to.eq(LogLevel.Error);

    log.debug("x");
    log.info("y");
    expect(target.getRecords().length).to.eq(0);

    log.error("z");
    await Promise.resolve();
    expect(target.getRecords().length).to.eq(1);
    expect(target.getRecords()[0].Variables.message).to.eq("z");
  });

  it("near-zero-cost: a gated debug() never reaches the target's write()", () => {
    const log = logger();
    const target = memoryTarget(log);
    target.clear();

    log.setLevel("error", false);

    const spy = sinon.spy(target, "write");
    try {
      log.debug("should not build an entry");
      expect(spy.called).to.eq(false);
      expect(target.getRecords().length).to.eq(0);
    } finally {
      spy.restore();
    }
  });

  it("resetLevel() restores MinLevel and debug flows again", async () => {
    const log = logger();
    const target = memoryTarget(log);
    target.clear();

    log.setLevel("error", false);
    log.resetLevel();
    expect(log.getLevel()).to.eq(LogLevel.Trace);

    log.debug("back");
    await Promise.resolve();
    expect(target.getRecords().length).to.eq(1);
  });

  it("disableAll() gates even security(); enableAll() lets trace flow", async () => {
    const log = logger();
    const target = memoryTarget(log);
    target.clear();

    log.disableAll(false);
    log.security("nope");
    expect(target.getRecords().length).to.eq(0);

    log.enableAll(false);
    log.trace("yes");
    await Promise.resolve();
    expect(target.getRecords().length).to.eq(1);
  });

  it("setDefaultLevel() only applies when no override is set", () => {
    const log = logger();

    log.setDefaultLevel("warn");
    expect(log.getLevel()).to.eq(LogLevel.Warn);

    // an explicit choice wins; a later default must not clobber it
    log.setLevel("error", false);
    log.setDefaultLevel("trace");
    expect(log.getLevel()).to.eq(LogLevel.Error);
  });

  it("normalizeLevel maps names and numbers, throws on unknown", () => {
    expect(normalizeLevel("warn")).to.eq(LogLevel.Warn);
    expect(normalizeLevel(LogLevel.Warn)).to.eq(LogLevel.Warn);
    expect(() => normalizeLevel("nope")).to.throw(/Invalid log level/);
  });

  describe("persistence", () => {
    it("persists / reads / clears in a simulated browser", () => {
      const store = new Map<string, string>();
      const win: any = {
        localStorage: {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
      };

      const originalWindow = (global as any).window;
      (global as any).window = win;
      try {
        const log = logger("persist-test");
        log.setLevel("warn", true);

        expect(readPersistedLevel("persist-test")).to.eq(LogLevel.Warn);

        clearPersistedLevel("persist-test");
        expect(readPersistedLevel("persist-test")).to.eq(undefined);
      } finally {
        if (originalWindow === undefined) {
          delete (global as any).window;
        } else {
          (global as any).window = originalWindow;
        }
      }
    });

    it("on Node ( no window ) setLevel(persist) does not throw and reads undefined", () => {
      const log = logger("node-persist");
      expect(() => log.setLevel("warn", true)).to.not.throw();
      expect(readPersistedLevel("node-persist")).to.eq(undefined);
    });
  });
});
