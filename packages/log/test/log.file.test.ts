import "mocha";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import * as sinon from "sinon";
import * as fs from "fs";
import { Log } from "../src";
import * as _ from "lodash";
import { expect } from "chai";
import { TestConfiguration } from "./conf";

function logger(name?: string) {
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
  });

  afterEach(() => {
    sinon.restore();
  });

  it("Should write to file", async () => {
    const mk = sinon.mock(fs);
    const log = logger("file");
    const s2 = mk.expects("writeFileSync");

    log.info("Hello world");

    expect(s2.calledOnce).to.be.true;
    expect(s2.args[0][1])
      .to.be.a("string")
      .and.satisfy((msg: string) => msg.includes("INFO Hello world"));
  });

  it("Should resolve file name with variables", async () => {});

  it("Should rotate log files when size is exceeded", async () => {});

  it("Should clean log files when criteria are met", async () => {});

  it("should create file logger per creation", async () => {});
});
