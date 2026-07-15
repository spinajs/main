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

// dedicated config: a single JsonTarget sink capturing every level so we can
// read the NDJSON line back and assert on its structure.
class JsonTargetConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
        dirs: {
          schemas: [dir("./../src/schemas")],
        },
      },
      logger: {
        targets: [
          {
            name: "Json",
            type: "JsonTarget",
          },
        ],
        rules: [{ name: "*", level: "trace", target: "Json" }],
      },
    };
  }
}

describe("JsonTarget NDJSON output", () => {
  let writeStub: sinon.SinonStub;

  before(async () => {
    DI.clearCache();
    DI.register(JsonTargetConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    writeStub = sinon.stub(process.stdout, "write");
  });

  afterEach(() => {
    writeStub.restore();
  });

  // returns the string written by the single expected write() call
  function written(): string {
    expect(writeStub.callCount).to.eq(1);
    return writeStub.firstCall.args[0] as string;
  }

  it("plain string call writes one JSON line with time/level/logger/message", async () => {
    const log = DI.resolve(Log, ["json-plain"]);
    await log.info("hello %s", "world");

    const line = written();
    expect(line.endsWith("\n")).to.eq(true);
    const parsed = JSON.parse(line);
    expect(parsed.time).to.be.a("string");
    expect(parsed.level).to.eq("INFO");
    expect(parsed.logger).to.eq("json-plain");
    expect(parsed.message).to.eq("hello world");
  });

  it("merging-object call carries merged fields", async () => {
    const log = DI.resolve(Log, ["json-merge"]);
    await log.info({ reqId: "abc" }, "checkout");

    const parsed = JSON.parse(written());
    expect(parsed.reqId).to.eq("abc");
    expect(parsed.message).to.eq("checkout");
  });

  it("error call carries a structured error object", async () => {
    const log = DI.resolve(Log, ["json-error"]);
    await log.error(new Error("boom"));

    const parsed = JSON.parse(written());
    expect(parsed.error).to.be.an("object");
    expect(parsed.error.name).to.be.a("string");
    expect(parsed.error.message).to.eq("boom");
    expect(parsed.error.stack).to.be.a("string");
  });

  it("circular field does not throw and serializes as [Circular]", async () => {
    const log = DI.resolve(Log, ["json-circular"]);
    const self: any = {};
    self.self = self;

    // must not throw
    await log.info({ self }, "msg");

    const line = written();
    expect(line).to.contain("[Circular]");
    // still valid JSON
    expect(() => JSON.parse(line)).to.not.throw();
    const parsed = JSON.parse(line);
    expect(parsed.message).to.eq("msg");
  });
});
