import "mocha";
import { expect } from "chai";
import { AsyncLocalStorage } from "node:async_hooks";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";
import { LogContext } from "../src/context.js";
import { setLogContextProvider } from "@spinajs/log-common";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

// single Memory sink capturing every level so we can read entry Variables back.
class ContextConfiguration extends FrameworkConfiguration {
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

function sink(): MemoryTarget {
  return DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);
}

describe("LogContext ambient async context", () => {
  before(async () => {
    DI.clearCache();
    DI.register(ContextConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    // the LogBotstrapper is not run in this isolated suite, so wire the seam
    // ourselves exactly as bootstrap.ts does.
    setLogContextProvider(() => LogContext.active());
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    sink().clear();
  });

  // ---- Step 0: shared-singleton proof kept as a regression test ------------
  it("resolves AsyncLocalStorage as a shared singleton with a cross-visible store", () => {
    const a = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<any>;
    const b = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<any>;

    expect(a).to.equal(b);
    expect(a.run({ x: 1 }, () => b.getStore())).to.deep.equal({ x: 1 });
  });

  it("with(...) injects ambient fields into log entries; outside has none", async () => {
    const log = DI.resolve(Log, ["ctx-with"]);

    LogContext.with({ requestId: "abc" }, () => {
      log.info("inside");
    });
    log.info("outside");

    const records = sink().getRecords();
    expect(records.length).to.eq(2);
    expect(records[0].Variables.requestId).to.eq("abc");
    expect(records[1].Variables.requestId).to.be.undefined;
  });

  it("nests: with({a:1}, with({b:2}, active())) => { a:1, b:2 }", () => {
    const nested = LogContext.with({ a: 1 }, () => LogContext.with({ b: 2 }, () => LogContext.active()));
    expect(nested).to.deep.eq({ a: 1, b: 2 });
  });

  it("context survives an await", async () => {
    const seen = await LogContext.with({ requestId: "r" }, async () => {
      await Promise.resolve();
      return LogContext.active().requestId;
    });
    expect(seen).to.eq("r");
  });

  it("bind captures the store and re-attaches it when invoked outside with()", () => {
    let bound: () => string | undefined = () => undefined;

    LogContext.with({ requestId: "bound-req" }, () => {
      bound = LogContext.bind(() => LogContext.active().requestId as string | undefined);
    });

    // invoked with no active context - must still see the captured store
    expect(LogContext.active().requestId).to.be.undefined;
    expect(bound()).to.eq("bound-req");
  });

  it("bind also carries the store into a detached callback that logs", (done) => {
    const log = DI.resolve(Log, ["ctx-bind-log"]);

    let cb: () => void = () => undefined;
    LogContext.with({ requestId: "cb-req" }, () => {
      cb = LogContext.bind(() => {
        log.info("from detached callback");
      });
    });

    setTimeout(() => {
      cb();
      const records = sink().getRecords();
      expect(records.length).to.eq(1);
      expect(records[0].Variables.requestId).to.eq("cb-req");
      done();
    }, 0);
  });

  // ---- http-reuse proof: no import of @spinajs/http --------------------------
  it("http-reuse: als.run(store) from the shared DI singleton feeds logs", () => {
    const log = DI.resolve(Log, ["ctx-http"]);
    const als = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;

    als.run({ requestId: "http-req" }, () => {
      log.info("x");
    });

    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.requestId).to.eq("http-req");
  });

  it("set() late-binds a value onto the active store", () => {
    const captured = LogContext.with({ requestId: "s1" }, () => {
      LogContext.set("realIp", "1.2.3.4");
      return LogContext.active();
    });
    expect(captured).to.deep.eq({ requestId: "s1", realIp: "1.2.3.4" });
  });

  // ---- precedence: explicit vars beat ambient context -----------------------
  it("explicit per-call variables override ambient context", () => {
    const log = DI.resolve(Log, ["ctx-precedence"]);

    LogContext.with({ requestId: "ambient" }, () => {
      log.info({ requestId: "explicit" }, "m");
    });

    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    expect(records[0].Variables.requestId).to.eq("explicit");
  });

  after(() => {
    // restore the default no-op provider so sibling suites in a shared process
    // are not affected by this suite's wiring.
    setLogContextProvider(() => ({}));
  });
});
