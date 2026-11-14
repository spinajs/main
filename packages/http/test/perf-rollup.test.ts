import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { useTestApp } from "@spinajs/testing";
import { Perf, PerfSink, IPerfRollup } from "@spinajs/log";
import { PerfRollup } from "../src/middlewares/PerfRollup.js";
import { TestConfiguration } from "./common.js";

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

  /** The request's context, as the server gives it to every hook; `path` is set when a route matched. */
  const ctxOf = (url: string, status: number, requestId: string, path?: string) => {
    const req: any = { method: "GET", originalUrl: url, storage: { requestId } };
    return { req, res: { statusCode: status, locals: {} } as any, storage: req.storage, path };
  };

  it("creates a scope on req.storage and flushes one rollup on finish", async () => {
    const mw = await DI.resolve(PerfRollup);
    const ctx = ctxOf("/x", 200, "r1");

    mw.onBefore(ctx);
    expect(ctx.req.storage.perf).to.be.an("object"); // onBefore created the scope
    // a measurement recorded during the "action" bumps the scope
    ctx.req.storage.perf.byName["orm.query"] = { count: 3, totalMs: 30, maxMs: 12 };

    mw.onFinish({ ...ctx, aborted: false });

    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].requestId).to.eq("r1");
    expect(sink.rollups[0].byName["orm.query"].count).to.eq(3);
    expect(sink.rollups[0].labels).to.deep.include({ method: "GET", route: "/x", status: 200 });
  });

  it("falls back to the path without the query when no route matched", async () => {
    const mw = await DI.resolve(PerfRollup);
    const ctx = ctxOf("/x/42?token=Zq7perfTokenRw3", 404, "r3");

    mw.onBefore(ctx);
    mw.onFinish({ ...ctx, aborted: false });

    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].labels).to.deep.include({ method: "GET", route: "/x/42", status: 404 });
  });

  it("uses the mounted path of the matched route for the route label", async () => {
    const mw = await DI.resolve(PerfRollup);
    const ctx = ctxOf("/x/42", 200, "r2", "http:GET /x/:id");

    mw.onBefore(ctx);
    mw.onFinish({ ...ctx, aborted: false });

    expect(sink.rollups).to.have.length(1);
    expect(sink.rollups[0].labels).to.deep.include({ method: "GET", route: "/x/:id", status: 200 });
  });

  it("flushes nothing for a request the client went away from", async () => {
    const mw = await DI.resolve(PerfRollup);
    const ctx = ctxOf("/x", 200, "r4");

    mw.onBefore(ctx);
    mw.onFinish({ ...ctx, aborted: true });

    expect(sink.rollups).to.have.length(0);
  });
});
