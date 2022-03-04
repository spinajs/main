/* eslint-disable @typescript-eslint/no-empty-function */
import "mocha";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import * as sinon from "sinon";
import * as fs from "fs";
import { Log, LogBotstrapper } from "../src";
import * as _ from "lodash";
import { expect } from "chai";
import { TestConfiguration } from "./conf";
import { DateTime } from "luxon";

function logger(name?: string) {
  DI.resolve(LogBotstrapper).bootstrap();
  return DI.resolve(Log, [name ?? "TestLogger"]);
}

describe("file target tests", function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(() => {
    Log.clearLoggers();

    DI.uncashe("__log_file_targets__");
  });

  afterEach(() => {
    sinon.restore();
  });

  it("Should write to file",  () => {
    const mk = sinon.mock(fs);
    const log = logger("file");
    const s2 = mk.expects("writeFileSync");

    log.info("Hello world");

    expect(s2.calledOnce).to.be.true;
    expect(s2.args[0][1])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("INFO Hello world"));
  });

  it("Should resolve file name with variables", () => {

    const sSpy = sinon.spy(fs, "openSync");
    const log = logger("file");
    log.warn("test");

    expect(sSpy.getCall(0).args[0]).to.satisfy((name :string) => name.includes(`log_${DateTime.now().toFormat("dd_MM_yyyy")}.txt`))
  });

  it("Should rotate log files when size is exceeded", async () => {});

  it("Should clean log files when criteria are met", async () => {});

  it("should create file logger per creation", () => {

    // const sSpy = sinon.spy(fs, "openSync");

    // const loggers =  logger("file");
    // const loggers =  logger("file2");

    // expect(sSpy.callCount).to.eq(2);

  });
});
