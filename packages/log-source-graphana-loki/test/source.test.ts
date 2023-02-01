/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { DI } from "@spinajs/di";
import * as sinon from "sinon";
import { expect } from "chai";
import { Log, LogBotstrapper } from "@spinajs/log";
import _ from "lodash";
import axios from "axios";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";

import "./../src/index.js";

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
    process.exit();
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
});
