/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable security/detect-non-literal-fs-filename */
/* eslint-disable @typescript-eslint/no-empty-function */
import "mocha";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import * as sinon from "sinon";
import { FileTarget, Log, LogBotstrapper } from "../src/index.js";
import * as _ from "lodash";
import { dir, TestConfiguration } from "./conf.js";
import { expect } from "chai";
import { DateTime } from "luxon";

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
import fs from "fs";

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
  this.timeout(25000);

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
    sinon.restore();

    const target = DI.get(FileTarget);
    await target.dispose();

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      fs.rm(dir("./logs"), { recursive: true, force: true }, (err: any) => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  });

  it("Should write to different files", async () => {
    const appendFile = sinon.stub(fs, "appendFile").yields(null);

    const log1 = logger("file");
    const log2 = logger("file2");

    log1.info("Hello world 1");
    log2.info("Hello world 2");

    await wait(3000);

    expect(appendFile.args[0][0]).to.contain(`log_File.txt`);
    expect(appendFile.args[1][0]).to.contain(`log_File2.txt`);

    expect(appendFile.args[0][1]).to.contain(`Hello world 1`);
    expect(appendFile.args[1][1]).to.contain(`Hello world 2`);
  });

  it("Should archive file", async () => {
    const log = logger("file-archive-no-compress");
    let i = 0;
    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(4000);
    expect(fs.existsSync(dir("./logs/archive/archived_log_file-archive-no-compress_1.txt"))).to.be.true;
  });

  it("Should delete archive files after limit", async () => {
    const log = logger("file-archive");

    let i = 0;
    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(4000);

    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });
    await wait(4000);

    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(4000);
    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(4000);

    expect(fs.existsSync(dir("./logs/archive/archived_log_file-archive_1.txt.gzip"))).to.be.false;
    expect(fs.existsSync(dir("./logs/archive/archived_log_file-archive_2.txt.gzip"))).to.be.true;
    expect(fs.existsSync(dir("./logs/archive/archived_log_file-archive_3.txt.gzip"))).to.be.true;
  });

  it("Should compress archived files", async () => {
    const log = logger("file-archive");
    Array.from(Array(10000), () => {
      log.info(`Hello world`);
    });

    await wait(6000);

    Array.from(Array(10000), () => {
      log.info(`Hello world`);
    });

    await wait(6000);

    expect(fs.existsSync(dir("./logs/archive/archived_log_file-archive_1.txt.gzip"))).to.be.true;
    expect(fs.existsSync(dir("./logs/archive/archived_log_file-archive_2.txt.gzip"))).to.be.true;
  });

  it("Should maintain order of log enties", async () => {
    const log = logger("big-buffer");
    let i = 0;
    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(500);

    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(500);

    Array.from(Array(10000), () => {
      log.info(`[${i++}]`);
    });

    await wait(500);

    Array.from(Array(10), () => {
      log.info(`[${i++}]`);
    });
    await wait(500);

    Array.from(Array(10), () => {
      log.info(`[${i++}]`);
    });
    await wait(500);

    Array.from(Array(10), () => {
      log.info(`[${i++}]`);
    });
    await wait(2000);

    const result = fs.readFileSync(dir("./logs/log_big-buffer.txt"), "utf8") as string;
    const entries = result.split("\n");

    const reg = /\[(\d+)\]/gm;
    let prev = -1;

    expect(entries.length).to.eq(30031);
    expect(
      _.every(
        entries.filter((x) => x !== ""),
        (entry) => {
          const result = reg.exec(entry);
          reg.lastIndex = 0;
          const num = parseInt(result[1]);
          const curr = prev;
          prev = num;
          return curr < num;
        }
      )
    ).to.be.true;
  });

  it("Should write with big buffer size with many messages", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("big-buffer");

    Array.from(Array(1100), () => {
      log.info("Hello world");
    });

    await wait(1000);

    expect(appendFile.called).to.eq(true);
    expect((appendFile.args[0][1] as unknown as string[]).length).to.greaterThan(6000);
  });

  it("Should write with big buffer size with few messages", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("big-buffer");

    Array.from(Array(10), () => {
      log.info("Hello world");
    });

    await wait(2000);

    expect(appendFile.called).to.eq(true);
    expect((appendFile.args[0][1] as unknown as string[]).length).to.greaterThan(600);
  });

  it("Should write formatted message", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("file-vars");
    log.warn("test ${date:dd_MM_yyyy}");

    await wait(1000);

    expect(appendFile.args[0][1]).to.contain(`test ${DateTime.now().toFormat("dd_MM_yyyy")}`);
  });

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
      expect((a[1] as unknown as string[]).length).to.greaterThan(60000);
    });
  });

  it("Performance test", () => {
    console.time("FILE");
    const log = logger("file-vars");
    Array.from(Array(10000), () => {
      log.info("Hello world");
    });
    console.timeEnd("FILE");
  });

  it("Should resolve file name with variables", async () => {
    const appendFile = sinon.stub(fs, "appendFile");
    const log = logger("file-vars");
    log.warn("test");

    await wait(1000);

    expect(appendFile.args[0][0]).to.contain(`log_file-vars_${DateTime.now().toFormat("dd_MM_yyyy")}.txt`);
  });
});
