/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import * as sinon from "sinon";
import { expect } from "chai";
import _ from "lodash";
import { DateTime } from "luxon";
import { DI, Injectable } from "@spinajs/di";
import { Configuration, ConfigVariable } from "@spinajs/configuration";
import { TestConfiguration } from "./conf.js";
import { TestWildcard } from "./targets/TestWildcard.js";
import { TestLevel } from "./targets/TestLevel.js";
import { BlackHoleTarget } from "./../src/targets/BlackHoleTarget.js";
import { TestTarget } from "./targets/TestTarget.js";
import { LogLevel, Log } from "../src/index.js";



@Injectable(ConfigVariable)
export class CustomVariable extends ConfigVariable {
  public get Name(): string {
    return "custom-var";
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public Value(_option?: string): string {
    return "hello-custom-var";
  }
}

function logger(name?: string) {
  return DI.resolve(Log, [name ?? "TestLogger"]);
}

describe("logger tests", function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
  });

  afterEach(() => {
    sinon.restore();
  });

  after(() => {
    process.exit();
  });

  it("Should create logger", async () => {
    const log = logger();

    expect(log).to.be.not.null;
    expect(log.Name).to.eq("TestLogger");
  });

  it("Should log proper levels", async () => {
    const log = logger();
    const spy = sinon.spy(BlackHoleTarget.prototype, "write");

    log.trace("Hello world");
    log.debug("Hello world");
    log.info("Hello world");
    log.success("Hello world");
    log.warn("Hello world");
    log.error("Hello world");
    log.fatal("Hello world");
    log.security("Hello world");

    expect((spy.args[0] as any)[0]).to.have.property("Level", LogLevel.Trace);
    expect((spy.args[1] as any)[0]).to.have.property("Level", LogLevel.Debug);
    expect((spy.args[2] as any)[0]).to.have.property("Level", LogLevel.Info);
    expect((spy.args[3] as any)[0]).to.have.property("Level", LogLevel.Success);
    expect((spy.args[4] as any)[0]).to.have.property("Level", LogLevel.Warn);
    expect((spy.args[5] as any)[0]).to.have.property("Level", LogLevel.Error);
    expect((spy.args[6] as any)[0]).to.have.property("Level", LogLevel.Fatal);
    expect((spy.args[7] as any)[0]).to.have.property("Level", LogLevel.Security);
  });

  it("Should log with default layout", () => {
    const log = logger("test-format");
    const spy = sinon.spy(TestTarget.prototype, "sink");

    log.trace("Hello world");
    log.debug("Hello world");
    log.info("Hello world");
    log.success("Hello world");
    log.warn("Hello world");
    log.error("Hello world");
    log.fatal("Hello world");
    log.security("Hello world");

    const now = DateTime.now();

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("TRACE Hello world  (test-format)"));
    expect(spy.args[1][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("DEBUG Hello world  (test-format)"));
    expect(spy.args[2][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("INFO Hello world  (test-format)"));
    expect(spy.args[3][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("SUCCESS Hello world  (test-format)"));
    expect(spy.args[4][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("WARN Hello world  (test-format)"));
    expect(spy.args[5][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("ERROR Hello world  (test-format)"));
    expect(spy.args[6][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("FATAL Hello world  (test-format)"));
    expect(spy.args[7][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.startsWith(now.toFormat("dd/MM/yyyy")) && msg.endsWith("SECURITY Hello world  (test-format)"));
  });

  it("Should not create new logger with same name", () => {
    const log = logger("test-format");
    const log2 = logger("test-format");

    expect(log).to.be.eq(log2);
  });

  it("Should log to multiple targets", () => {
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const spy2 = sinon.spy(TestLevel.prototype, "sink");

    const log = logger("multiple-targets");

    log.info("Hello");

    expect(spy.calledOnce).to.be.true;
    expect(spy2.calledOnce).to.be.true;
  });

  it("Should log from sources by wildcard", () => {
    const spy = sinon.spy(TestWildcard.prototype, "sink");

    const log = logger("multiple-targets");
    const log2 = logger("http/post/controller");
    const log3 = logger("http/get/controller");

    log.info("hello");
    log2.info("world");
    log3.info("from");

    expect(spy.calledTwice).to.be.true;

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("world"));
    expect(spy.args[1][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("from"));
  });

  it("Check layout variables are avaible", () => {
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const log = logger("test-layout");
    const date = DateTime.now();

    log.info("Hello");

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes(`${date.toFormat("dd-MM-yyyy")} ${date.toFormat("HH:mm")} Hello hello-custom-var`));
  });

  it("Should log variable with options", () => {
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const log = logger("test-format");
    const date = DateTime.now();

    log.info("Hello ${time:HH:mm}");

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes(`Hello ${date.toFormat("HH:mm")}`));
  });

  it("Should format log func arguments", () => {
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const log = logger("test-format");

    log.info("%s %d", "Hello", 666);

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("Hello 666"));
  });

  it("Custom variables should be avaible in message", () => {
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const log = logger("test-variable");

    log.info("${custom-var}");

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("hello-custom-var"));
  });

  it("Should write log only with specified level", () => {
    const log = logger("test-level");
    const spy = sinon.spy(TestLevel.prototype, "write");

    log.trace("Hello world");
    expect(spy.callCount).to.eq(0);
    log.warn("Hello world");
    expect(spy.calledOnce).to.be.true;
  });

  it("Should write exception message along with user message", () => {
    const err = new Error("error message");
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const log = logger("test-format");

    log.error(err, "hello world err");

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("ERROR hello world err Error: error message"));
  });

  it('Should format message with one argunt', () =>{ 
    const spy = sinon.spy(TestTarget.prototype, "sink");
    const log = logger("test-format");

    log.info("Hello %s", "world");

    expect(spy.args[0][0])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("Hello world"));
  })
});
