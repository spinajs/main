import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import { Perf, PerfSink, IPerfRollup } from "@spinajs/log";
import { PerfRollup } from "../src/middlewares/PerfRollup.js";
import { TestConfiguration } from "./common.js";
import { EventEmitter } from "node:events";

class RecordingSink extends PerfSink {
  public rollups: IPerfRollup[] = [];
  public collect(): void {
    /* ignore individual metrics here */
  }
  public onScopeEnd(r: IPerfRollup): void {
    this.rollups.push(r);
  }
}

function resetDi() {
  DI.uncache(TestConfiguration);
  DI.uncache(Array.ofType(PerfSink));
  DI.uncache(RecordingSink);
  DI.uncache(PerfRollup);
}

describe("PerfRollup middleware", () => {
  let sink: RecordingSink;

  beforeEach(async () => {
    // Not DI.clearCache(): it also wipes cache-only maps such as __http_error_map__.
    resetDi();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    DI.register(RecordingSink).as(PerfSink);
    sink = DI.resolve(Array.ofType(PerfSink)).find((s) => s instanceof RecordingSink) as RecordingSink;
    Perf.refreshSinks();
  });

  afterEach(() => {
    resetDi();
    DI.unregister(RecordingSink);
  });

  it("creates a scope on req.storage and flushes one rollup on finish", async () => {
    const mw = await DI.resolve(PerfRollup);
    const handler = mw.before()!;

    const req: any = { method: "GET", originalUrl: "/x", storage: { requestId: "r1" } };
    const res: any = new EventEmitter();
    res.statusCode = 200;

    handler(req, res, () => undefined);
    expect(req.storage.perf).to.be.an("object"); // before() created the scope
    // a measurement recorded during the "action" bumps the scope
    req.storage.perf.byName["orm.query"] = { count: 3, totalMs: 30, maxMs: 12 };

    res.emit("finish");

    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].requestId).to.eq("r1");
    expect(sink.rollups[0].byName["orm.query"].count).to.eq(3);
    expect(sink.rollups[0].labels).to.deep.include({ method: "GET", route: "/x", status: 200 });
  });

  it("uses req.route.path for the route label when a matched route is present", async () => {
    const mw = await DI.resolve(PerfRollup);
    const handler = mw.before()!;

    const req: any = { method: "GET", originalUrl: "/x/42", route: { path: "/x/:id" }, storage: { requestId: "r2" } };
    const res: any = new EventEmitter();
    res.statusCode = 200;

    handler(req, res, () => undefined);
    res.emit("finish");

    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].labels).to.deep.include({ method: "GET", route: "/x/:id", status: 200 });
  });
});
