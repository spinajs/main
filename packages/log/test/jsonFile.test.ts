/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { expect } from "chai";
import { Configuration } from "@spinajs/configuration";
import { DI } from "@spinajs/di";
import { FsBootsrapper, fsService, fs } from "@spinajs/fs";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { dir, TestConfiguration } from "./conf.js";
import { JsonFileTarget, Log, LogBotstrapper } from "../src/index.js";

// Own Configuration subclass ( distinct class identity ) so this suite's
// `DI.register(...).as(Configuration)` does not collide with the identical
// TestConfiguration registration used by log.file.test.ts when both run in the
// same shared test process. It inherits the same targets / fs providers.
class JsonFileConfiguration extends TestConfiguration {}

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
 * Reads the active JSON log file for a given logger name straight from the
 * local disk ( the `logs` provider is rooted at test/logs ).
 */
function readLog(loggerName: string): string {
  const p = dir(`./logs/log_${loggerName}.txt`);
  return existsSync(p) ? (readFileSync(p, "utf8") as string) : "";
}

/** Non-empty NDJSON lines parsed into objects. */
function readLines(loggerName: string): any[] {
  return readLog(loggerName)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/**
 * Waits until the target has drained its buffer AND the write-lock is idle, so
 * assertions do not race an in-flight flush.
 */
async function drain(target: any) {
  for (let i = 0; i < 100; i++) {
    await (target as any).Ready?.catch(() => {});
    await (target as any).WriteLock?.catch(() => {});
    if ((target as any).Queue.size === 0) {
      return;
    }
    await wait(50);
  }
}

describe("json file target tests", function () {
  this.timeout(30000);

  before(async () => {
    DI.clearCache();
    DI.uncache(Configuration);
    DI.uncache("__file_provider_instance__");
    DI.resolve(FsBootsrapper).bootstrap();
    DI.register(JsonFileConfiguration).as(Configuration);
    const cfg = await DI.resolve<any>(Configuration);
    const svc = new fsService();
    Object.defineProperty(svc, "Config", { value: cfg.get("fs"), configurable: true });
    await svc.resolve();
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    DI.uncache(JsonFileTarget);
    DI.uncache("JsonFileTarget");
    rmSync(dir("./logs"), { recursive: true, force: true });
    mkdirSync(dir("./logs/archive"), { recursive: true });
  });

  afterEach(async () => {
    const target = DI.get(JsonFileTarget);
    if (target) {
      await target.dispose();
    }
    rmSync(dir("./logs"), { recursive: true, force: true });
  });

  it("Should write one JSON object per line with the core fields", async () => {
    const log = logger("json-file");
    log.info("Hello world");
    log.warn("second");

    const target = DI.get(JsonFileTarget)!;
    await drain(target);

    const lines = readLines("json-file");
    expect(lines.length).to.eq(2);

    for (const rec of lines) {
      expect(rec).to.be.an("object");
      expect(rec.time).to.be.a("string");
      expect(rec.severityNumber).to.be.a("number");
      expect(rec.level).to.be.a("string");
      expect(rec.logger).to.be.a("string");
      expect(rec.message).to.be.a("string");
    }

    expect(lines[0].message).to.eq("Hello world");
    expect(lines[0].level).to.eq("INFO");
    expect(lines[0].severityNumber).to.eq(9);
    expect(lines[1].message).to.eq("second");
    expect(lines[1].level).to.eq("WARN");
    expect(lines[1].severityNumber).to.eq(13);
  });

  it("Should serialize an Error into a structured error object", async () => {
    const log = logger("json-file");
    log.error(new Error("boom"));

    const target = DI.get(JsonFileTarget)!;
    await drain(target);

    const lines = readLines("json-file");
    expect(lines.length).to.eq(1);

    const rec = lines[0];
    expect(rec.level).to.eq("ERROR");
    expect(rec.severityNumber).to.eq(17);
    expect(rec.error).to.be.an("object");
    expect(rec.error.name).to.eq("Error");
    expect(rec.error.message).to.eq("boom");
    expect(rec.error.stack).to.be.a("string");
  });

  it("Should include merged fields from a merging-object call", async () => {
    const log = logger("json-file");
    log.info({ reqId: "abc" }, "msg");

    const target = DI.get(JsonFileTarget)!;
    await drain(target);

    const lines = readLines("json-file");
    expect(lines.length).to.eq(1);
    expect(lines[0].message).to.eq("msg");
    expect(lines[0].reqId).to.eq("abc");
  });

  it("Should rotate JSON logs too ( inherited FileTarget rotation )", async () => {
    // tiny maxSize + archiveInterval 1 so writing enough lines rotates. Proves
    // the inherited FileTarget rotation applies to the JSON subclass unchanged.
    const log = logger("json-file-archive");
    for (let i = 0; i < 2000; i++) {
      log.info({ i }, `entry ${i}`);
    }

    const target = DI.get(JsonFileTarget)! as any;
    await drain(target);
    await target.ArchiveService.rotate(target.Context);

    const archiveFs = await fsProvider("archive");
    const files = await archiveFs.list("/");
    const archives = files.filter((f) => f.startsWith("archived_"));
    expect(archives.length, "expected at least one archived file").to.be.greaterThan(0);

    // an uncompressed archive line must still be valid NDJSON
    const plain = archives.find((f) => !f.endsWith(".zip"));
    if (plain) {
      const content = (await archiveFs.read(plain, "utf8")).toString();
      const firstLine = content.split("\n").find((l) => l.trim() !== "");
      expect(firstLine, "archive should contain a line").to.be.a("string");
      const rec = JSON.parse(firstLine as string);
      expect(rec.severityNumber).to.eq(9);
      expect(rec.level).to.eq("INFO");
    }
  });
});
