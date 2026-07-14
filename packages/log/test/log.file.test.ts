/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { expect } from "chai";
import _ from "lodash";
import { DateTime } from "luxon";
import { Configuration } from "@spinajs/configuration";
import { DI } from "@spinajs/di";
import { FsBootsrapper, fsService, fs } from "@spinajs/fs";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { dir, TestConfiguration } from "./conf.js";
import { FileTarget, Log, LogBotstrapper } from "../src/index.js";

function logger(name?: string) {
  DI.resolve(LogBotstrapper).bootstrap();
  return DI.resolve(Log, [name ?? "TestLogger"]);
}

function wait(amount: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, amount || 1000));
}

async function fsProvider(name: string): Promise<fs> {
  return DI.resolve<fs>("__file_provider__", [name]);
}

/**
 * Reads the active log file for a given logger name straight from the local
 * disk ( the `logs` provider is rooted at test/logs ).
 */
function readLog(loggerName: string): string {
  const p = dir(`./logs/log_${loggerName}.txt`);
  return existsSync(p) ? (readFileSync(p, "utf8") as string) : "";
}

/**
 * Waits until the target has drained its buffer AND the write-lock is idle, so
 * assertions do not race an in-flight flush.
 */
async function drain(target: any) {
  for (let i = 0; i < 100; i++) {
    await (target as any).Ready?.catch(() => {});
    await (target as any).WriteLock?.catch(() => {});
    if ((target as any).Buffer.length === 0) {
      return;
    }
    await wait(50);
  }
}

describe("file target tests", function () {
  this.timeout(30000);

  before(async () => {
    // fully reset DI so a prior suite ( eg. archive ) that registered its own
    // Configuration + fs providers cannot leak into this one. clearCache alone
    // leaves the fsService singleton resolved, so its providers are never
    // re-registered - uncache it explicitly.
    DI.clearCache();
    DI.uncache(Configuration);
    DI.uncache("__file_provider_instance__");
    DI.resolve(FsBootsrapper).bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    const cfg = await DI.resolve<any>(Configuration);
    // run a FRESH fsService ( not the possibly-cached singleton from a prior
    // suite ) with this suite's fs config so its providers ( logs / archive ) are
    // registered into the __file_provider_instance__ map
    const svc = new fsService();
    Object.defineProperty(svc, "Config", { value: cfg.get("fs"), configurable: true });
    await svc.resolve();
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    // clearLoggers disposes targets; drop the cached ( now disposed ) FileTarget
    // instances so the next logger builds a fresh, non-disposed target
    DI.uncache(FileTarget);
    DI.uncache("FileTarget");
    rmSync(dir("./logs"), { recursive: true, force: true });
    // recreate provider base dirs ( providers create them once at resolve )
    mkdirSync(dir("./logs/archive"), { recursive: true });
  });

  afterEach(async () => {
    const target = DI.get(FileTarget);
    if (target) {
      await target.dispose();
    }
    rmSync(dir("./logs"), { recursive: true, force: true });
  });

  it("Should write buffered message to the log file", async () => {
    const log = logger("file");
    log.info("Hello world");

    const target = DI.get(FileTarget)!;
    await drain(target);

    expect(readLog("file")).to.contain("Hello world");
  });

  it("Should write to different files per logger", async () => {
    const log1 = logger("file");
    const log2 = logger("file2");

    log1.info("Hello world 1");
    log2.info("Hello world 2");

    await drain(DI.get(FileTarget)!);
    await wait(200);

    expect(readLog("file")).to.contain("Hello world 1");
    expect(readLog("file2")).to.contain("Hello world 2");
  });

  it("Should format message with variables", async () => {
    const log = logger("file-vars");
    log.warn("test ${date:dd_MM_yyyy}");

    const target = DI.get(FileTarget)!;
    await drain(target);
    await wait(200);

    const p = dir(`./logs/log_file-vars_${DateTime.now().toFormat("dd_MM_yyyy")}.txt`);
    expect(existsSync(p)).to.be.true;
    expect(readFileSync(p, "utf8")).to.contain(`test ${DateTime.now().toFormat("dd_MM_yyyy")}`);
  });

  it("Should write every message exactly once ( no loss / no dup )", async () => {
    const log = logger("big-buffer");
    const count = 5000;
    for (let i = 0; i < count; i++) {
      log.info(`[${i}]`);
    }

    const target = DI.get(FileTarget)!;
    await drain(target);
    // one extra flush cycle for anything still buffered under maxBufferSize
    await wait(1200);
    await drain(target);

    const content = readLog("big-buffer");
    const seen = new Set<number>();
    const reg = /\[(\d+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = reg.exec(content)) !== null) {
      const n = parseInt(m[1], 10);
      expect(seen.has(n), `duplicate entry ${n}`).to.be.false;
      seen.add(n);
    }

    for (let i = 0; i < count; i++) {
      expect(seen.has(i), `missing entry ${i}`).to.be.true;
    }
    expect(seen.size).to.eq(count);
  });

  it("Should maintain order of log entries", async () => {
    const log = logger("big-buffer");
    let i = 0;
    for (let b = 0; b < 3; b++) {
      Array.from(Array(3000), () => log.info(`[${i++}]`));
      await wait(300);
    }
    Array.from(Array(30), () => log.info(`[${i++}]`));

    const target = DI.get(FileTarget)!;
    await drain(target);
    await wait(1200);
    await drain(target);

    const entries = readLog("big-buffer").split("\n").filter((x) => x !== "");
    const reg = /\[(\d+)\]/;
    let prev = -1;
    let ordered = true;
    for (const e of entries) {
      const r = reg.exec(e);
      if (!r) continue;
      const num = parseInt(r[1], 10);
      if (num <= prev) {
        ordered = false;
        break;
      }
      prev = num;
    }
    expect(ordered).to.be.true;
    expect(entries.length).to.eq(i);
  });

  it("Should not drop messages when a rotation happens mid-write", async () => {
    // uncompressed archive target ( maxSize 1000, interval 1 ) so archived
    // content is readable as plain text
    const log = logger("file-archive-no-compress");
    const count = 8000;
    for (let i = 0; i < count; i++) {
      log.info(`[${i}]`);
    }

    const target = DI.get(FileTarget)! as any;
    await drain(target);

    // force a rotation while more writes come in
    for (let i = count; i < count + 2000; i++) {
      log.info(`[${i}]`);
    }
    if (target.Context && target.ArchiveService) {
      await target.ArchiveService.rotate(target.Context);
    }
    for (let i = count + 2000; i < count + 4000; i++) {
      log.info(`[${i}]`);
    }
    await drain(target);
    await wait(1500);
    await drain(target);

    // collect everything: active log + every archived file
    const archiveFs = await fsProvider("archive");

    let content = readLog("file-archive-no-compress");
    for (const f of await archiveFs.list("/")) {
      if (!f.startsWith("archived_") || f.endsWith(".zip")) continue;
      content += "\n" + (await archiveFs.read(f, "utf8")).toString();
    }

    const seen = new Set<number>();
    const reg = /\[(\d+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = reg.exec(content)) !== null) {
      seen.add(parseInt(m[1], 10));
    }

    const total = count + 4000;
    let missing = 0;
    for (let i = 0; i < total; i++) {
      if (!seen.has(i)) missing++;
    }
    expect(missing, `missing ${missing} entries`).to.eq(0);
  });

  it("Should preserve messages when an append fails once then succeeds", async () => {
    const log = logger("big-buffer");
    const target = DI.get(FileTarget)! as any;
    await target.Ready;

    // fail the very next append, then restore
    const realFs = target.Fs as fs;
    const origAppend = realFs.append.bind(realFs);
    let failed = false;
    (realFs as any).append = async (...args: any[]) => {
      if (!failed) {
        failed = true;
        throw new Error("disk full");
      }
      return origAppend(...(args as [string, string]));
    };

    const count = 2000;
    for (let i = 0; i < count; i++) {
      log.info(`[${i}]`);
    }

    await drain(target);
    await wait(1200);
    await drain(target);
    (realFs as any).append = origAppend;
    await target.flush();
    await drain(target);

    const content = readLog("big-buffer");
    const seen = new Set<number>();
    const reg = /\[(\d+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = reg.exec(content)) !== null) {
      seen.add(parseInt(m[1], 10));
    }
    for (let i = 0; i < count; i++) {
      expect(seen.has(i), `missing entry ${i}`).to.be.true;
    }
  });

  it("Should drop oldest and cap the buffer when appends fail persistently", async () => {
    const log = logger("big-buffer");
    const target = DI.get(FileTarget)! as any;
    await target.Ready;

    // shrink the hard cap for a fast, deterministic test
    const cap = 50;
    target.Options.options.maxQueueSize = cap;

    // make every append fail so the batch is always prepended back -> buffer
    // would grow unbounded without the cap. Fs providers are shared singletons,
    // so restore the original append afterwards to avoid leaking into other tests.
    const realFs = target.Fs as fs;
    const origAppend = realFs.append.bind(realFs);
    (realFs as any).append = async () => {
      throw new Error("disk full");
    };

    try {
      // push far more than the cap; each push runs enforceQueueCap()
      for (let i = 0; i < cap * 10; i++) {
        log.info(`[${i}]`);
      }

      // let flush timers run so the failure-path prepend + cap also exercises
      await wait(1200);

      expect(target.Buffer.length).to.be.at.most(cap);
      expect(target.Overflowed).to.be.true;
    } finally {
      (realFs as any).append = origAppend;
    }
  });

  it("Should compress rotated archives into a zip", async () => {
    const log = logger("file-archive"); // compress: true, maxSize 1000
    for (let i = 0; i < 5000; i++) {
      log.info(`Hello world ${i}`);
    }

    const target = DI.get(FileTarget)! as any;
    await drain(target);
    await target.ArchiveService.rotate(target.Context);

    const archiveFs = await fsProvider("archive");
    const files = await archiveFs.list("/");
    const zips = files.filter((f) => f.startsWith("archived_") && f.endsWith(".zip"));
    expect(zips.length).to.be.greaterThan(0);
  });
});
