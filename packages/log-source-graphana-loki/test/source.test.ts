/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { DI } from "@spinajs/di";
import * as sinon from "sinon";
import { expect } from "chai";
import { Log, LogBotstrapper } from "@spinajs/log";
import _ from "lodash";
import axios from "axios";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";

import { GraphanaLokiLogTarget } from "./../src/index.js";

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return target.concat(source);
  }
}

function logger(name?: string) {
  DI.resolve(LogBotstrapper).bootstrap();
  return DI.resolve(Log, [name ?? "TestLogger"]);
}

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: "Console",
            type: "BlackHoleTarget",
          },
          {
            name: "Graphana",
            type: "GraphanaLogTarget",
            options: {
              interval: 500,
              timeout: 1000,
              host: "http://localhost",
              auth: {
                username: "admin",
                password: "admin",
              },
              labels: {
                app: "spinajs-test",
              },
            },
          },
        ],

        rules: [
          { name: "graphana", level: "trace", target: "Graphana" },
          { name: "graphana", level: "trace", target: "Console" }
        ],
      },
    }
  }
}

function wait(amount: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, amount || 1000);
  });
}

describe("logger tests", function () {
  this.timeout(25000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(() => {
  });

  afterEach(async () => {
    sinon.restore();
    Log.clearLoggers();

  });

  after(() => {
    if (!process.env.NO_EXIT) process.exit();
  });

  it("Should send with custom labels", async () => {
    const request = sinon.stub(axios, "post").callsFake(() => Promise.resolve({ status: 200 }));
    const log1 = logger("graphana");

    log1.info("Hello world 1");
    await wait(1000);

    expect(request.args[0][0]).to.equal("http://localhost/loki/api/v1/push");
    expect((request.args[0][1] as any).data.streams[0].stream).to.include({
      app: "spinajs-test",
      logger: "graphana",
      level: "INFO",
    });

    expect(parseInt((request.args[0][1] as any).data.streams[0].values[0][0])).to.be.a("number");
    expect((request.args[0][1] as any).data.streams[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");
  });

  it("Should send multiple log entries", async () => {
    const request = sinon.stub(axios, "post").callsFake(() => Promise.resolve({ status: 200 }));
    const log1 = logger("graphana");

    log1.info("Hello world 1");
    log1.warn("Hello warn");

    await wait(1000);

    expect((request.args[0][1] as any).data.streams[0].stream).to.include({
      app: "spinajs-test",
      level: "INFO",
      logger: "graphana",
    });

    expect((request.args[0][1] as any).data.streams[1].stream).to.include({
      app: "spinajs-test",
      level: "WARN",
      logger: "graphana",
    });

    expect(parseInt((request.args[0][1] as any).data.streams[0].values[0][0])).to.be.a("number");
    expect((request.args[0][1] as any).data.streams[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");

    expect(parseInt((request.args[0][1] as any).data.streams[1].values[0][0])).to.be.a("number");
    expect((request.args[0][1] as any).data.streams[1].values[0][1]).to.contain("WARN Hello warn  (graphana)");
  });

  it("Should add same item in same stream", async () => {
    const request = sinon.stub(axios, "post").callsFake(() => Promise.resolve({ status: 200 }));
    const log1 = logger("graphana");

    log1.info("Hello world 1");
    log1.info("Hello world 2");
    log1.info("Hello world 3");

    await wait(1000);

    expect((request.args[0][1] as any).data.streams[0].stream).to.include({
      app: "spinajs-test",
      level: "INFO",
      logger: "graphana",
    });

    expect(parseInt((request.args[0][1] as any).data.streams[0].values[0][0])).to.be.a("number");
    expect((request.args[0][1] as any).data.streams[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");

    expect(parseInt((request.args[0][1] as any).data.streams[0].values[1][0])).to.be.a("number");
    expect((request.args[0][1] as any).data.streams[0].values[1][1]).to.contain("INFO Hello world 2  (graphana)");

    expect(parseInt((request.args[0][1] as any).data.streams[0].values[2][0])).to.be.a("number");
    expect((request.args[0][1] as any).data.streams[0].values[2][1]).to.contain("INFO Hello world 3  (graphana)");
  });

  it("Should not clear buffer after send failed", async () => {
    const request = sinon
      .stub(axios, "post")
      .onCall(0)
      .returns(Promise.reject({ status: 500 }))
      .onCall(1)
      .returns(Promise.resolve({ status: 200 }));

    const log1 = logger("graphana");

    log1.info("Hello world 1");
    log1.info("Hello world 2");
    log1.info("Hello world 3");

    await wait(3000);

    expect(request.calledTwice).to.be.true;

    expect((request.args[1][1] as any).data.streams[0].stream).to.include({
      app: "spinajs-test",
      level: "INFO",
      logger: "graphana",
    });

    expect(parseInt((request.args[1][1] as any).data.streams[0].values[0][0])).to.be.a("number");
    expect((request.args[1][1] as any).data.streams[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");

    expect(parseInt((request.args[1][1] as any).data.streams[0].values[1][0])).to.be.a("number");
    expect((request.args[1][1] as any).data.streams[0].values[1][1]).to.contain("INFO Hello world 2  (graphana)");

    expect(parseInt((request.args[1][1] as any).data.streams[0].values[2][0])).to.be.a("number");
    expect((request.args[1][1] as any).data.streams[0].values[2][1]).to.contain("INFO Hello world 3  (graphana)");
  });

  // NOTE: the config-driven suite above resolves targets through DI where the
  // GraphanaLokiLogTarget reads its options flat ( this.Options.auth ) while the
  // config nests them under `options` - a pre-existing options-nesting bug that
  // predates these changes ( the suite never compiled before ). The tests below
  // construct the target directly with flat options so the Step 3 behaviour
  // ( super.resolve, retry-buffer cap, flush/dispose promises ) can be verified.

  function buildTarget(extra?: any) {
    const target: any = new GraphanaLokiLogTarget({
      name: "Graphana",
      layout: "${datetime} ${level} ${message} (${logger})",
      interval: 100000, // effectively disable the timer; we drive flush() manually
      bufferSize: 100000,
      timeout: 1000,
      host: "http://localhost",
      auth: { username: "admin", password: "admin" },
      labels: { app: "spinajs-test" },
      ...extra,
    } as any);

    // @Logger injection does not run for a direct `new`; Log is a getter-only
    // accessor, so override it with a no-op logger for the test.
    Object.defineProperty(target, "Log", {
      configurable: true,
      value: { trace() {}, info() {}, warn() {}, error() {}, fatal() {}, debug() {}, security() {}, success() {} },
    });
    return target;
  }

  function entry(msg: string): any {
    return { Level: 4, Variables: { logger: "graphana", level: "INFO", message: msg, n_timestamp: Date.now() * 1000000 } };
  }

  it("Should be resolved after resolve()", () => {
    sinon.stub(axios, "post").callsFake(() => Promise.resolve({ status: 200 }));
    const target = buildTarget();
    expect(target.Resolved).to.eq(false);
    target.resolve();
    expect(target.Resolved).to.eq(true);
    clearInterval(target.FlushTimer);
  });

  it("Should cap the retry buffer and drop oldest on repeated failures", async () => {
    const target = buildTarget({ maxBufferSize: 50 });
    target.resolve();
    clearInterval(target.FlushTimer); // drive flush manually

    // stub the actual instance method used by flush()
    const post = sinon.stub(target.AxiosInstance, "post").callsFake(() => Promise.reject(new Error("boom")));

    // repeatedly enqueue > cap entries and flush; failed flushes retain for retry
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 100; i++) {
        target.WriteEntries.push(entry(`entry-${round}-${i}`));
      }
      await target.flush();
      // after each failed flush the retained buffer must never exceed the cap
      expect(target.WriteEntries.length).to.be.at.most(50);
    }

    // the newest entries survive ( oldest were dropped )
    const last = target.WriteEntries[target.WriteEntries.length - 1];
    expect(last.Variables.message).to.eq("entry-5-99");

    // now let writes succeed and confirm retained entries deliver exactly once
    post.restore();
    const ok = sinon.stub(target.AxiosInstance, "post").callsFake(() => Promise.resolve({ status: 200 }));

    await target.flush();

    expect(ok.calledOnce).to.be.true;
    expect(target.WriteEntries.length).to.eq(0);
  });

  it("dispose() awaits the final flush", async () => {
    const target = buildTarget();
    target.resolve();

    let resolvePost: (v: unknown) => void = () => {};
    const postPromise = new Promise((r) => (resolvePost = r));
    sinon.stub(target.AxiosInstance, "post").callsFake(() => postPromise as any);

    target.WriteEntries.push(entry("last message"));

    let disposed = false;
    const p = target.dispose().then(() => (disposed = true));

    // dispose must not resolve until the in-flight post settles
    await wait(50);
    expect(disposed).to.eq(false);

    resolvePost({ status: 200 });
    await p;
    expect(disposed).to.eq(true);
  });
});
