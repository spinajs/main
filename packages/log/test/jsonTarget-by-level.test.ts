import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

class JsonByLevelConfiguration extends FrameworkConfiguration {
  // The tests are written against no package config; the file sources would load every installed @spinajs package's.
  protected loadSources(): void {
    this.Sources = [];
  }

  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir("./../src/schemas")],
        },
      },
      logger: {
        targets: [{ name: "Json", type: "JsonTarget", stream: "by-level" }],
        rules: [{ name: "*", level: "trace", target: "Json" }],
      },
    };
  }
}

describe("JsonTarget stream: by-level", () => {
  let out: sinon.SinonStub;
  let err: sinon.SinonStub;

  before(async () => {
    DI.clearCache();
    DI.register(JsonByLevelConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    out = sinon.stub(process.stdout, "write");
    err = sinon.stub(process.stderr, "write");
  });

  afterEach(() => {
    out.restore();
    err.restore();
  });

  const levelsOf = (stub: sinon.SinonStub) => stub.getCalls().map((c) => JSON.parse(c.args[0] as string).level as string);

  it("writes trace, debug, info and success to stdout", async () => {
    const log = DI.resolve(Log, ["json-by-level-out"]);
    await log.trace("t");
    await log.debug("d");
    await log.info("i");
    await log.success("s");

    expect(levelsOf(out)).to.deep.eq(["TRACE", "DEBUG", "INFO", "SUCCESS"]);
    expect(err.callCount).to.eq(0);
  });

  it("writes warn, error, fatal and security to stderr", async () => {
    const log = DI.resolve(Log, ["json-by-level-err"]);
    await log.warn("w");
    await log.error("e");
    await log.fatal("f");
    await log.security("x");

    expect(levelsOf(err)).to.deep.eq(["WARN", "ERROR", "FATAL", "SECURITY"]);
    expect(out.callCount).to.eq(0);
  });
});
