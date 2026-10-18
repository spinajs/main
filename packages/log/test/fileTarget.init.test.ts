import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { FsBootsrapper, fsService } from "@spinajs/fs";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { dir } from "./conf.js";
import { FileTarget, Log } from "../src/index.js";

// a `*` rule also routes the target's own diagnostics logger ( LogFileTarget ) to it
class RootFileConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      fs: { defaultProvider: "init-logs", providers: [{ service: "fsNative", name: "init-logs", basePath: dir("./init-logs") }] },
      logger: {
        targets: [{ name: "Root", type: "FileTarget", options: { fs: "init-logs", path: "root.txt" } }],
        rules: [{ name: "*", level: "trace", target: "Root" }],
      },
    };
  }
}

async function bootFs() {
  const svc = new fsService();
  Object.defineProperty(svc, "Config", { value: DI.get<any>(Configuration).get("fs"), configurable: true });
  await svc.resolve();
}

function readRoot() {
  const p = dir("./init-logs/root.txt");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("file target init", function () {
  this.timeout(10000);

  beforeEach(async () => {
    await Log.clearLoggers();
    DI.clearCache();
    DI.uncache(Configuration);
    DI.uncache("__file_provider_instance__");
    DI.uncache(FileTarget);
    DI.uncache("FileTarget");
    mkdirSync(dir("./init-logs"), { recursive: true });
    DI.resolve(FsBootsrapper).bootstrap();
    DI.register(RootFileConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await Log.clearLoggers();
    rmSync(dir("./init-logs"), { recursive: true, force: true });
  });

  it("writes when a `*` rule routes its own logger to it and the path has no directory", async () => {
    await bootFs();
    DI.resolve(Log, ["init-root"]).info("hello root");
    await Log.flushAll();

    expect(readRoot()).to.contain("hello root");
  });

  it("writes entries logged before the fs provider was registered", async () => {
    DI.resolve(Log, ["init-late"]).info("before fs");
    await Log.flushAll();
    expect(readRoot()).to.eq("");

    await bootFs();
    await Log.flushAll();

    expect(readRoot()).to.contain("before fs");
  });
});
