/* eslint-disable @typescript-eslint/no-empty-function */
import "mocha";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import * as sinon from "sinon";
import { Log, LogBotstrapper } from "../src";
import * as _ from "lodash";
import { dir, TestConfiguration } from "./conf";
import { expect } from "chai";
import { DateTime } from "luxon";

const fs = require("fs");

function logger(name?: string) {
  DI.resolve(LogBotstrapper).bootstrap();
  return DI.resolve(Log, [name ?? "TestLogger"]);
}

function wait(amount: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, amount || 1000);
  });
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

  afterEach(async () => {
    return new Promise((resolve) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.rmdir(dir("./logs"), () => {});

      resolve();
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it("Should write to file", () => {
    const log = logger("file");
    log.info("Hello world");
  });

  it("Should create multiple instances of file target", () => {});

  it("Should write to different files", () => {});

  it("Should archive file", () => {});

  it("Should delete archive files after limit", () => {});

  it("Should resolve log file name with variables", () => {});

  it("Should create multiple log files per config", () => {});

  it("Should compress archived files", () => {});

  it("Should write to file", async () => {});

  it("Should write with big buffer size with many messages", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("big-buffer");

    Array.from(Array(1100), () => {
      log.info("Hello world");
    });

    await wait(1000);

    expect(appendFile.called).to.eq(true);
    expect((appendFile.args[0][1] as string[]).length).to.greaterThan(6000);
  });

  it("Should write with big buffer size with few messages", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("big-buffer");

    Array.from(Array(10), () => {
      log.info("Hello world");
    });

    await wait(2000);

    expect(appendFile.called).to.eq(true);
    expect((appendFile.args[0][1] as string[]).length).to.greaterThan(600);
  });

  it("Should write formatted message", async () => {});

  it("Should not write multiple times same messages", async () => {
    const appendFile = sinon.stub(fs, "appendFile").yields(null);
    const log = logger("file");

    log.info("Hello world");

    await wait(3000);

    expect(appendFile.called).to.eq(true);
    expect(appendFile.callCount).to.equal(1);
  });

  it("Should do multiple writes to file", async () => {
    const appendFile = sinon.stub(fs, "appendFile").yields(null);
    const log = logger("big-buffer");

    Array.from(Array(10), () => {
      log.info("Hello world");
    });

    await wait(2000);

    Array.from(Array(10), () => {
      log.info("Hello world");
    });

    await wait(2000);

    Array.from(Array(10), () => {
      log.info("Hello world");
    });

    await wait(2000);

    expect(appendFile.called).to.eq(true);
    expect(appendFile.callCount).to.equal(3);
  });

  it("Should write big log", async () => {
    const appendFile = sinon.stub(fs, "appendFile").yields(null);
    const log = logger("big-buffer");

    Array.from(Array(10000), () => {
      log.info("Hello world");
    });

    await wait(500);

    Array.from(Array(10000), () => {
      log.info("Hello world");
    });

    await wait(500);

    Array.from(Array(10000), () => {
      log.info("Hello world");
    });

    expect(appendFile.called).to.eq(true);
    appendFile.args.forEach((a) => {
      expect((a[2] as string[]).length).to.greaterThan(60000);
    });
  });

  it("Performance test", () => {});

  it("Should resolve file name with variables", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("file-vars");
    log.warn("test");

    await wait(1000);

    expect(appendFile.args[0][0]).to.contain(`log_file-vars_${DateTime.now().toFormat("dd_MM_yyyy")}.txt`);
  });
});
