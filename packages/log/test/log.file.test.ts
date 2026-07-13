/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable security/detect-non-literal-fs-filename */
/* eslint-disable @typescript-eslint/no-empty-function */
import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import _ from "lodash";
import { DateTime } from "luxon";
import { Configuration } from "@spinajs/configuration";
import { DI } from "@spinajs/di";
import { dir, TestConfiguration } from "./conf.js";
import { FileTarget, Log, LogBotstrapper } from "../src/index.js";
import fs from "fs";
import glob from "glob";

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

  beforeEach(async () => {
    await Log.clearLoggers();
    DI.uncache("__log_file_targets__");
  });

  afterEach(async () => {
    sinon.restore();

    const target = DI.get(FileTarget)!;
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
          const num = parseInt(result![1]);
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

  it("Should not lose or duplicate messages when appendFile callbacks are delayed", async () => {
    // delay every appendFile callback so multiple flush ticks overlap with in-flight writes
    const pending: Array<() => void> = [];
    const appendFile = sinon.stub(fs, "appendFile").callsFake((...cbArgs: any[]) => {
      const cb = cbArgs[cbArgs.length - 1] as (err: any) => void;
      pending.push(() => cb(null));
    });

    const log = logger("big-buffer");
    const count = 3000; // > maxBufferSize (1000)

    for (let i = 0; i < count; i++) {
      log.info(`[${i}]`);
    }

    // let a few flush/write ticks happen while callbacks are still pending
    await wait(1500);
    for (let i = 0; i < count; i++) {
      log.info(`[${count + i}]`);
    }
    await wait(1500);

    // now settle all pending appendFile callbacks
    pending.forEach((fn) => fn());
    await wait(1500);

    // collect everything that was handed to appendFile
    const written = appendFile.args.map((a) => a[1] as unknown as string).join("");
    const seen = new Set<number>();
    const reg = /\[(\d+)\]/gm;
    let m: RegExpExecArray | null;
    let total = 0;
    while ((m = reg.exec(written)) !== null) {
      const num = parseInt(m[1]);
      expect(seen.has(num), `duplicate entry ${num}`).to.be.false;
      seen.add(num);
      total++;
    }

    expect(total).to.eq(2 * count);
    for (let i = 0; i < 2 * count; i++) {
      expect(seen.has(i), `missing entry ${i}`).to.be.true;
    }
  });

  it("Should not lose messages when appendFile fails once then succeeds", async () => {
    let call = 0;
    const appendFile = sinon.stub(fs, "appendFile").callsFake((...cbArgs: any[]) => {
      const cb = cbArgs[cbArgs.length - 1] as (err: any) => void;
      call++;
      // fail the first write, succeed afterwards
      cb(call === 1 ? new Error("disk full") : null);
    });

    const log = logger("big-buffer");
    const count = 2000;
    for (let i = 0; i < count; i++) {
      log.info(`[${i}]`);
    }

    await wait(3000);

    const written = appendFile.args.map((a) => a[1] as unknown as string).join("");
    const seen = new Set<number>();
    const reg = /\[(\d+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = reg.exec(written)) !== null) {
      seen.add(parseInt(m[1]));
    }

    for (let i = 0; i < count; i++) {
      expect(seen.has(i), `missing entry ${i}`).to.be.true;
    }
  });

  // The archive() glob path is timing/environment sensitive when exercised through
  // the real timers, so these two drive archive() directly with a controlled set of
  // "files" ( glob + fs stubbed ) to deterministically test the state machine and
  // the index-correctness fix.

  // helper: build a FileTarget and stub glob/fs so archive() sees the given log files
  function stubArchiveEnv(logFiles: Array<{ name: string; size: number }>) {
    // aFiles glob (archived_*) -> empty, lFiles glob (*.txt) -> our files
    sinon.stub(glob, "sync").callsFake((pattern: string) => {
      if (pattern.includes("archived_")) {
        return [];
      }
      return logFiles.map((f) => f.name);
    });
    sinon.stub(fs, "statSync").callsFake(((p: string) => {
      const f = logFiles.find((x) => x.name === p);
      return { size: f ? f.size : 0, mtime: new Date() } as any;
    }) as any);
  }

  it("Should return ArchiveStatus to IDLE after a rename error (no PENDING deadlock)", async () => {
    logger("file-archive");
    const target = DI.get(FileTarget)! as any;

    // three log files, all above maxSize (1000) so all are candidates
    stubArchiveEnv([
      { name: "/logs/log_a.txt", size: 5000 },
      { name: "/logs/log_b.txt", size: 5000 },
      { name: "/logs/log_c.txt", size: 5000 },
    ]);

    // every rename fails
    const rename = sinon.stub(fs, "rename").callsFake((...cbArgs: any[]) => {
      const cb = cbArgs[cbArgs.length - 1] as (err: any) => void;
      cb(new Error("rename failed"));
    });

    target.ArchiveStatus = 1; // PENDING
    target.archive();

    // give the rename callbacks a tick to settle
    await wait(50);

    expect(rename.callCount).to.eq(3);
    // 2 === IDLE ; without the fix this would stay PENDING (1)
    expect(target.ArchiveStatus).to.eq(2);
  });

  it("Should archive exactly the filtered files using the correct index", async () => {
    logger("file-archive");
    const target = DI.get(FileTarget)! as any;

    // maxSize is 1000; only the big file exceeds it. With >=2 files the filter also
    // keeps all-but-last, so a & b are archived, c ( last, small ) is not.
    stubArchiveEnv([
      { name: "/logs/log_a.txt", size: 5000 },
      { name: "/logs/log_b.txt", size: 10 },
      { name: "/logs/log_c.txt", size: 10 },
    ]);

    const renamed: string[] = [];
    sinon.stub(fs, "rename").callsFake((...cbArgs: any[]) => {
      renamed.push(cbArgs[0] as string);
      const cb = cbArgs[cbArgs.length - 1] as (err: any) => void;
      cb(null);
    });

    target.ArchiveStatus = 1; // PENDING
    target.archive();
    await wait(50);

    // a (big) and b (all-but-last) are archived; c (last, small) is left in place
    expect(renamed).to.have.members(["/logs/log_a.txt", "/logs/log_b.txt"]);
    expect(renamed).to.not.include("/logs/log_c.txt");
  });
});
