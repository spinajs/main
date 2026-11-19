import "mocha";
import { expect } from "chai";
import { existsSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
import { getLogStdoutStream, setLogStdoutStream } from "../src/index.js";

const SLOT = Symbol.for("@spinajs/log-common/stdout-stream");

describe("setLogStdoutStream() / getLogStdoutStream()", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, SLOT);
  });

  it("defaults to stdout", () => {
    expect(getLogStdoutStream()).to.eq("stdout");
  });

  it("reads a stream set through another copy of the package, which shares only globalThis", () => {
    Reflect.set(globalThis, SLOT, "stderr");

    expect(getLogStdoutStream()).to.eq("stderr");
  });

  // CI runs `npm run build` first ( lib/cjs, marked CommonJS by prepare-module-support ), so there it must not skip
  it("is seen by the CommonJS build when the ESM build sets it (needs the CommonJS build: npm run build)", function () {
    const cjs = resolve("lib/cjs/index.js");
    if (!existsSync(cjs) || !existsSync(resolve("lib/cjs/package.json"))) {
      if (process.env.CI) {
        throw new Error("lib/cjs of @spinajs/log-common is not built; run npm run build before the tests");
      }
      this.skip();
    }

    const commonJs = createRequire(cjs)(cjs) as { getLogStdoutStream: () => string; setLogStdoutStream: (s: "stdout" | "stderr") => void };

    setLogStdoutStream("stderr");
    expect(commonJs.getLogStdoutStream()).to.eq("stderr");

    commonJs.setLogStdoutStream("stdout");
    expect(getLogStdoutStream()).to.eq("stdout");
  });
});
