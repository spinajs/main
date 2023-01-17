/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { DI } from "@spinajs/di";
import * as sinon from "sinon";
import { expect } from "chai";
import { Log, LogBotstrapper } from "@spinajs/log";
import * as _ from "lodash";
import axios from "axios";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";

// eslint-disable-next-line import/no-duplicates
import "./../src/index";

// importing type for only type annotation couset module to not load
// eslint-disable-next-line import/no-duplicates
import { GraphanaLokiLogTarget } from "./../src";

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
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: "Graphana",
              type: "GraphanaLogTarget",
              options: {
                interval: 500,
                timeout: 1000,
                host: "http://localhost",
                labels: {
                  app: "spinajs-test",
                },
              },
            },
          ],

          rules: [{ name: "*", level: "trace", target: "Graphana" }],
        },
      },
      mergeArrays
    );
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
    Log.clearLoggers();
  });

  afterEach(async () => {
    sinon.restore();

    const target = DI.get<GraphanaLokiLogTarget>("GraphanaLogTarget");
    await target.dispose();
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
    expect((request.args[0][1] as any).data[0].labels).to.include({
      app: "spinajs-test",
      logger: "graphana",
      level: "INFO",
    });

    expect((request.args[0][1] as any).data[0].values[0][0]).to.be.a("number");
    expect((request.args[0][1] as any).data[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");
  });

  it("Should send multiple log entries", async () => {
    const request = sinon.stub(axios, "post").callsFake(() => Promise.resolve({ status: 200 }));
    const log1 = logger("graphana");

    log1.info("Hello world 1");
    log1.warn("Hello warn");

    await wait(1000);

    expect((request.args[0][1] as any).data[0].labels).to.include({
      app: "spinajs-test",
      logger: "graphana",
      level: "INFO",
    });

    expect((request.args[0][1] as any).data[1].labels).to.include({
      app: "spinajs-test",
      logger: "graphana",
      level: "WARN",
    });

    expect((request.args[0][1] as any).data[0].values[0][0]).to.be.a("number");
    expect((request.args[0][1] as any).data[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");

    expect((request.args[0][1] as any).data[1].values[0][0]).to.be.a("number");
    expect((request.args[0][1] as any).data[1].values[0][1]).to.contain("WARN Hello warn  (graphana)");
  });

  it("Should add same item in same stream", async () => {
    const request = sinon.stub(axios, "post").callsFake(() => Promise.resolve({ status: 200 }));
    const log1 = logger("graphana");

    log1.info("Hello world 1");
    log1.info("Hello world 2");
    log1.info("Hello world 3");

    await wait(1000);

    expect((request.args[0][1] as any).data[0].labels).to.include({
      app: "spinajs-test",
      logger: "graphana",
      level: "INFO",
    });

    expect((request.args[0][1] as any).data[0].values[0][0]).to.be.a("number");
    expect((request.args[0][1] as any).data[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");

    expect((request.args[0][1] as any).data[0].values[1][0]).to.be.a("number");
    expect((request.args[0][1] as any).data[0].values[1][1]).to.contain("INFO Hello world 2  (graphana)");

    expect((request.args[0][1] as any).data[0].values[2][0]).to.be.a("number");
    expect((request.args[0][1] as any).data[0].values[2][1]).to.contain("INFO Hello world 3  (graphana)");
  });

  it("Should not clear buffer after send failed", async () => {
    const request = sinon
      .stub(axios, "post")
      .onCall(0)
      .callsFake(() => Promise.reject({ status: 500 }))
      .onCall(1)
      .callsFake(() => Promise.resolve({ status: 200 }));
    const log1 = logger("graphana");

    log1.info("Hello world 1");
    log1.info("Hello world 2");
    log1.info("Hello world 3");

    await wait(3000);

    expect(request.calledTwice).to.be.true;

    expect((request.args[1][1] as any).data[0].labels).to.include({
      app: "spinajs-test",
      logger: "graphana",
      level: "INFO",
    });

    expect((request.args[1][1] as any).data[0].values[0][0]).to.be.a("number");
    expect((request.args[1][1] as any).data[0].values[0][1]).to.contain("INFO Hello world 1  (graphana)");

    expect((request.args[1][1] as any).data[0].values[1][0]).to.be.a("number");
    expect((request.args[1][1] as any).data[0].values[1][1]).to.contain("INFO Hello world 2  (graphana)");

    expect((request.args[1][1] as any).data[0].values[2][0]).to.be.a("number");
    expect((request.args[1][1] as any).data[0].values[2][1]).to.contain("INFO Hello world 3  (graphana)");
  });
});
