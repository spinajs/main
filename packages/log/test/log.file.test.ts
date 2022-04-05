/* eslint-disable @typescript-eslint/no-empty-function */
import "mocha";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import * as sinon from "sinon";
//import * as fs from "fs";
import { Log, LogBotstrapper } from "../src";
//import { ILogTargetDesc } from "@spinajs/log-common";
import * as _ from "lodash";
import { TestConfiguration } from "./conf";

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
    DI.uncache("__log_file_targets__");
  });

  after(() => {
    // const log = logger("file");
    // const target = log.Targets.find((t: ILogTargetDesc) => {
    //   return t.instance instanceof FileTarget;
    // }).instance as FileTarget;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    //fs.unlinkSync(target.LogPath);
  });

  afterEach(() => {
    sinon.restore();
  });

  it("Should write to file", () => {
    const log = logger("file");

    log.info("Hello world");
    log.info("Hello world");
    log.info("Hello world");
    log.info("Hello world");
    log.info("Hello world");
    log.info("Hello world");
  });

  it("Performance test", () => {
    const log = logger("file-speed");
    for (let i = 0; i < 50000; i++) {
      log.info(`more speed line line ${i}`);
    }
  });

  // it("Should resolve file name with variables", () => {
  //   const sSpy = sinon.spy(fs, "openSync");
  //   const log = logger("file");
  //   log.warn("test");

  //   expect(sSpy.getCall(0).args[0]).to.satisfy((name: string) => name.includes(`log_${DateTime.now().toFormat("dd_MM_yyyy")}.txt`));
  // });

  // it("Should rotate log files when size is exceeded", async () => {});

  // it("Should clean log files when criteria are met", async () => {});

  // it("should create file logger per creation", () => {
  //   // const sSpy = sinon.spy(fs, "openSync");
  //   // const loggers =  logger("file");
  //   // const loggers =  logger("file2");
  //   // expect(sSpy.callCount).to.eq(2);
  // });
});
