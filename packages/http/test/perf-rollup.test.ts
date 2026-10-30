import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { useTestApp } from "@spinajs/testing";
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

describe("PerfRollup middleware", () => {
  let sink: RecordingSink;

  useTestApp({ configuration: TestConfiguration, bootstrap: false });

  afterEach(() => Perf.refreshSinks());

  beforeEach(() => {
    DI.register(RecordingSink).as(PerfSink);
    sink = DI.resolve(Array.ofType(PerfSink)).find((s) => s instanceof RecordingSink) as RecordingSink;
    Perf.refreshSinks();
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

  it("falls back to the path without the query when no route matched", async () => {
    const mw = await DI.resolve(PerfRollup);
    const handler = mw.before()!;

    const req: any = { method: "GET", originalUrl: "/x/42?token=Zq7perfTokenRw3", storage: { requestId: "r3" } };
    const res: any = new EventEmitter();
    res.statusCode = 404;

    handler(req, res, () => undefined);
    res.emit("finish");

    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].labels).to.deep.include({ method: "GET", route: "/x/42", status: 404 });
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
