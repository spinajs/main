/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import "@spinajs/configuration";
import { FsBootsrapper, fsService } from "@spinajs/fs";
import { InvalidOption } from "@spinajs/exceptions";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// side-effect: registers FrameworkLogger + log targets ( BlackHoleTarget ) and
// the archive strategies used by name resolution
import "../../src/index.js";
import {
  LogArchiveService,
  SizeLogArchiveStrategy,
  CountLogRetentionStrategy,
  AgeLogRetentionStrategy,
  ILogArchiveContext,
} from "../../src/archive/index.js";

import { makeConfig, makeWorkspace, makeOptions, makeContext, resolveFs } from "./common.js";

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("log archive subsystem", function () {
  this.timeout(20000);

  // fixed provider names + fixed base dirs, created once. Each test cleans the
  // dir CONTENTS ( not the providers ) so there is no cross-test file bleed and
  // no stale-basePath provider caching.
  // distinct provider names ( fs providers are cached by name across the shared
  // DI for the whole test process ) so this suite never collides with the file
  // target suite's providers when npm test runs everything in one process
  const activeName = "arch-suite-active";
  const archiveName = "arch-suite-store";
  let ws: ReturnType<typeof makeWorkspace>;

  before(async () => {
    ws = makeWorkspace();
    // full reset so a prior suite's Configuration cannot leak in
    DI.clearCache();
    DI.uncache(Configuration);
    DI.uncache("__file_provider_instance__");

    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(makeConfig(ws.activeBase, ws.archiveBase, activeName, archiveName)).as(Configuration);
    const cfg = await DI.resolve<any>(Configuration);
    // run a FRESH fsService ( not the possibly-cached singleton from a prior
    // suite ) so THIS suite's providers are registered into the provider map
    const svc = new fsService();
    Object.defineProperty(svc, "Config", { value: cfg.get("fs"), configurable: true });
    await svc.resolve();
  });

  beforeEach(async () => {
    // wipe dir contents between tests
    const activeFs = await resolveFs(activeName);
    const archiveFs = await resolveFs(archiveName);
    for (const f of await activeFs.list("/")) {
      await activeFs.rm(f);
    }
    for (const f of await archiveFs.list("/")) {
      await archiveFs.rm(f);
    }
  });

  after(() => {
    ws.cleanup();
  });

  async function ctxWithService(overrides: Parameters<typeof makeOptions>[0] = {}, archiveDir = "") {
    const activeFs = await resolveFs(activeName);
    const archiveFs = await resolveFs(archiveName);
    const options = makeOptions(overrides);

    const service = await DI.resolve(LogArchiveService);

    let ctx: ILogArchiveContext;
    ctx = makeContext({
      activeFs,
      archiveFs,
      activePath: options.path,
      archiveDir,
      options,
      rotate: () => service.rotate(ctx),
    });

    // ensure archive dir exists when set
    if (archiveDir) {
      await archiveFs.mkdir(archiveDir);
    }

    return { activeFs, archiveFs, options, service, ctx };
  }

  describe("SizeLogArchiveStrategy", () => {
    it("rotates when the active file exceeds maxSize", async () => {
      const { activeFs, archiveFs, service, ctx } = await ctxWithService({ maxSize: 50, archiveInterval: 60 });

      // write more than maxSize
      await activeFs.append("app.log", "x".repeat(200));
      expect(await activeFs.exists("app.log")).to.be.true;

      await service.start(ctx);
      const strategy: SizeLogArchiveStrategy = (service as any).ArchiveStrategy;

      // drive the size check directly rather than waiting for the interval
      await (strategy as any).check(ctx);
      service.stop();

      // active file gone, an archive was created
      expect(await activeFs.exists("app.log")).to.be.false;
      const archives = await archiveFs.list("/");
      expect(archives.filter((f) => f.startsWith("archived_")).length).to.eq(1);
    });

    it("does not rotate a file under maxSize", async () => {
      const { activeFs, archiveFs, service, ctx } = await ctxWithService({ maxSize: 10000 });
      await activeFs.append("app.log", "small");

      await service.start(ctx);
      await (service as any).ArchiveStrategy.check(ctx);
      service.stop();

      expect(await activeFs.exists("app.log")).to.be.true;
      const archives = (await archiveFs.list("/")).filter((f) => f.startsWith("archived_"));
      expect(archives.length).to.eq(0);
    });
  });

  describe("CronLogArchiveStrategy", () => {
    it("throws InvalidOption when rotate expression is missing", async () => {
      const { service, ctx } = await ctxWithService({ archiveStrategy: "CronLogArchiveStrategy", rotate: "" });
      let err: unknown;
      try {
        await service.start(ctx);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(InvalidOption);
    });

    it("throws InvalidOption on an invalid cron expression", async () => {
      const { service, ctx } = await ctxWithService({
        archiveStrategy: "CronLogArchiveStrategy",
        rotate: "not a cron",
      });
      let err: unknown;
      try {
        await service.start(ctx);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(InvalidOption);
    });

    it("fires a rotation on a fast cron schedule", async () => {
      const { activeFs, archiveFs, service, ctx } = await ctxWithService({
        archiveStrategy: "CronLogArchiveStrategy",
        rotate: "* * * * * *", // every second
      });
      await activeFs.append("app.log", "hello");

      await service.start(ctx);
      await wait(2500);
      service.stop();

      const archives = (await archiveFs.list("/")).filter((f) => f.startsWith("archived_"));
      expect(archives.length).to.be.greaterThan(0);
      expect(await activeFs.exists("app.log")).to.be.false;
    });
  });

  describe("CountLogRetentionStrategy", () => {
    it("keeps only the newest N archives", async () => {
      const { archiveFs } = await ctxWithService();
      const options = makeOptions({ maxArchiveFiles: 2 });

      // create 5 archive files with increasing mtime
      for (let i = 1; i <= 5; i++) {
        await archiveFs.append(`archived_app_${i}.log`, `data ${i}`);
        await wait(15);
      }

      const activeFs = await resolveFs(activeName);
      const service = await DI.resolve(LogArchiveService);
      let ctx: ILogArchiveContext;
      ctx = makeContext({
        activeFs,
        archiveFs,
        activePath: options.path,
        archiveDir: "",
        options,
        rotate: () => service.rotate(ctx),
      });

      const strategy = await DI.resolve(CountLogRetentionStrategy);
      await strategy.prune(ctx);

      const remaining = (await archiveFs.list("/")).filter((f) => f.startsWith("archived_")).sort();
      expect(remaining.length).to.eq(2);
      // newest two by mtime are _4 and _5
      expect(remaining).to.have.members(["archived_app_4.log", "archived_app_5.log"]);
    });
  });

  describe("AgeLogRetentionStrategy", () => {
    it("deletes archives older than maxAge", async () => {
      const { archiveFs } = await ctxWithService();
      const options = makeOptions({ maxAge: 3600 });
      const activeFs = await resolveFs(activeName);

      await archiveFs.append("archived_app_1.log", "old");
      await archiveFs.append("archived_app_2.log", "fresh");

      // backdate the first archive well beyond maxAge
      const oldPath = join(ws.archiveBase, "archived_app_1.log");
      const fsMod = await import("fs");
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      fsMod.utimesSync(oldPath, twoHoursAgo, twoHoursAgo);

      const service = await DI.resolve(LogArchiveService);
      let ctx: ILogArchiveContext;
      ctx = makeContext({
        activeFs,
        archiveFs,
        activePath: options.path,
        archiveDir: "",
        options,
        rotate: () => service.rotate(ctx),
      });

      const strategy = await DI.resolve(AgeLogRetentionStrategy);
      await strategy.prune(ctx);

      const remaining = (await archiveFs.list("/")).filter((f) => f.startsWith("archived_"));
      expect(remaining).to.deep.eq(["archived_app_2.log"]);
    });
  });

  describe("LogArchiveService.rotate", () => {
    it("compresses the archive into a zip and removes the raw file", async () => {
      const { activeFs, archiveFs, service, ctx } = await ctxWithService({ compress: true, maxSize: 10 });
      await activeFs.append("app.log", "compress me ".repeat(20));

      await service.rotate(ctx);

      const files = await archiveFs.list("/");
      const zips = files.filter((f) => f.startsWith("archived_") && f.endsWith(".zip"));
      const raws = files.filter((f) => f.startsWith("archived_") && !f.endsWith(".zip"));

      expect(zips.length).to.eq(1);
      expect(raws.length).to.eq(0);
      expect(await activeFs.exists("app.log")).to.be.false;
    });

    it("lands the archive in archiveFs when archiveFs !== fs", async () => {
      const { activeFs, archiveFs, service, ctx } = await ctxWithService({ compress: false });
      await activeFs.append("app.log", "cross fs content");

      await service.rotate(ctx);

      // archive must be on the ARCHIVE fs, not the active one
      const onArchive = (await archiveFs.list("/")).filter((f) => f.startsWith("archived_"));
      expect(onArchive.length).to.eq(1);

      const activeFiles = await activeFs.list("/");
      expect(activeFiles.filter((f) => f.startsWith("archived_")).length).to.eq(0);
      expect(await activeFs.exists("app.log")).to.be.false;

      // content preserved
      const body = readFileSync(join(ws.archiveBase, onArchive[0]), "utf8");
      expect(body).to.contain("cross fs content");
    });

    it("applies count + age retention together", async () => {
      const { activeFs, archiveFs, service, ctx } = await ctxWithService({
        compress: false,
        maxArchiveFiles: 3,
        maxAge: 3600,
        retentionStrategies: ["CountLogRetentionStrategy", "AgeLogRetentionStrategy"],
      });

      // pre-seed 4 archives; make one ancient
      for (let i = 1; i <= 4; i++) {
        await archiveFs.append(`archived_app_${i}.log`, `d${i}`);
        await wait(15);
      }
      const ancient = new Date(Date.now() - 2 * 3600 * 1000);
      const fsMod = await import("fs");
      fsMod.utimesSync(join(ws.archiveBase, "archived_app_2.log"), ancient, ancient);

      // now rotate the (existing) active file, triggering both retention passes
      await activeFs.append("app.log", "trigger");
      await service.start(ctx); // wires retention list
      await service.rotate(ctx);
      service.stop();

      const remaining = (await archiveFs.list("/")).filter((f) => f.startsWith("archived_"));
      // count keeps newest 3 of the 5 (4 seeded + 1 rotated), then age drops the ancient one if still present
      expect(remaining.length).to.be.lessThan(5);
      expect(remaining).to.not.include("archived_app_2.log"); // ancient always gone
    });

    it("releases the write-lock even when rotation fails", async () => {
      const { activeFs, service, ctx } = await ctxWithService({ compress: false });
      await activeFs.append("app.log", "data");

      // force rename to fail by removing the active file mid-flight via a stub
      const orig = activeFs.rename.bind(activeFs);
      (activeFs as any).rename = () => Promise.reject(new Error("boom"));

      let threw = false;
      try {
        await service.rotate(ctx);
      } catch {
        threw = true;
      }
      (activeFs as any).rename = orig;

      expect(threw).to.be.true;

      // lock must be free - a subsequent withWriteLock call resolves
      let ran = false;
      await ctx.withWriteLock(async () => {
        ran = true;
      });
      expect(ran).to.be.true;
    });
  });

  it("resolves the default strategies when none are configured", async () => {
    const { service, ctx } = await ctxWithService();
    await service.start(ctx);
    expect((service as any).ArchiveStrategy).to.be.instanceOf(SizeLogArchiveStrategy);
    expect((service as any).RetentionStrategies[0]).to.be.instanceOf(CountLogRetentionStrategy);
    service.stop();
    void existsSync; // keep import used
  });
});
