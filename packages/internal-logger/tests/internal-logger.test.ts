/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { Bootstrapper, DI } from "@spinajs/di";
import * as chai from "chai";
import * as sinon from "sinon";
import * as _ from "lodash";
import { BlackHoleTarget, LogLevel } from "@spinajs/log";
import { InternalLogger } from "./../src";

const expect = chai.expect;


export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.merge(this.Config, {
      logger: {
        targets: [
          {
            name: "Empty",
            type: "BlackHoleTarget",
          },
        ],

        rules: [{ name: "*", level: "trace", target: "Empty" }],
      },
    });
  }
}

describe("@spinajs/internal-logger", () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
  });

  afterEach(() => {
    sinon.restore();
  });

  it("should write logs before configuration is resolved and logger botstrapped", async () => {
    const spy = sinon.spy(BlackHoleTarget.prototype, "write");
    await DI.resolve(Configuration);

    InternalLogger.info("hello world", "test");

    await DI.resolve(Array.ofType(Bootstrapper));

    expect(spy.calledOnce).to.be.true;
    expect((spy.args[0] as any)[0]).to.have.property("Level", LogLevel.Trace);
  });

  it("Shold write log after botstrapped & before configuration", async () => {

    const spy = sinon.spy(BlackHoleTarget.prototype, "write");
    await DI.resolve(Array.ofType(Bootstrapper));
    await DI.resolve(Configuration);


    InternalLogger.info("hello world", "test");


    expect(spy.calledOnce).to.be.true;
    expect((spy.args[0] as any)[0]).to.have.property("Level", LogLevel.Trace);
  });

  it("Shold write multiple logs", async () => {

    const spy = sinon.spy(BlackHoleTarget.prototype, "write");
    await DI.resolve(Array.ofType(Bootstrapper));

    InternalLogger.info("hello world", "test");
    InternalLogger.info("hello world", "test");
    InternalLogger.info("hello world", "test");
    InternalLogger.info("hello world", "test");

    await DI.resolve(Configuration);

    expect(spy.callCount).to.eq(4);
  });

  it("should write logs after configuration is resolved", async () =>{ 
    const spy = sinon.spy(BlackHoleTarget.prototype, "write");
    await DI.resolve(Array.ofType(Bootstrapper));
    await DI.resolve(Configuration);

    InternalLogger.info("hello world", "test");
    InternalLogger.info("hello world", "test");
    InternalLogger.info("hello world", "test");
    InternalLogger.info("hello world", "test");

    expect(spy.callCount).to.eq(4);
  });
});
