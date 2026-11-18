import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration, FrameworkConfiguration, format } from "@spinajs/configuration";
import { InvalidArgument } from "@spinajs/exceptions";
import { LogVariables } from "@spinajs/log-common";
import { join, normalize, resolve } from "path";
import { Log } from "../src/index.js";
import { MemoryTarget } from "../src/targets/MemoryTarget.js";

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "test", path)));
}

class ErrorArgumentConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: { dirs: { schemas: [dir("./../src/schemas")] } },
      logger: {
        targets: [{ name: "Memory", type: "MemoryTarget" }],
        rules: [{ name: "*", level: "trace", target: "Memory" }],
      },
    };
  }
}

const DEFAULT_LAYOUT = "${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})";

describe("an error passed after the message", () => {
  before(async () => {
    DI.clearCache();
    DI.register(ErrorArgumentConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  beforeEach(async () => {
    await Log.clearLoggers();
    sink().clear();
  });

  function sink(): MemoryTarget {
    return DI.resolve(MemoryTarget, [{ name: "Memory", type: "MemoryTarget" }]);
  }

  function only(): LogVariables {
    const records = sink().getRecords();
    expect(records.length).to.eq(1);
    return records[0].Variables;
  }

  it("writes the error of log.warn(message, error) and prints its message", async () => {
    const log = DI.resolve(Log, ["ea-warn"]);
    await log.warn("read failed", new Error("disk gone"));

    const v = only();
    expect(v.message).to.eq("read failed");
    expect(v.error?.message).to.eq("disk gone");
    expect(format(v, DEFAULT_LAYOUT)).to.eq("WARN read failed Exception: disk gone (ea-warn)");
  });

  it("keeps the stack of log.error(message, error)", async () => {
    const log = DI.resolve(Log, ["ea-error"]);
    await log.error("read failed", new Error("disk gone"));

    const err = only().error;
    expect(err?.name).to.eq("Error");
    expect(err?.stack).to.contain("Error: disk gone");
  });

  it("writes the same entry as the error-first call", async () => {
    const log = DI.resolve(Log, ["ea-same"]);
    const error = new Error("disk gone");
    await log.warn("read failed", error);
    await log.warn(error, "read failed");

    const [trailing, first] = sink().getRecords().map((r) => r.Variables);
    expect(trailing).to.deep.eq(first);
  });

  it("formats the placeholders before the error and writes the error", async () => {
    const log = DI.resolve(Log, ["ea-format"]);
    await log.warn("read %s failed", "a.txt", new Error("disk gone"));

    const v = only();
    expect(v.message).to.eq("read a.txt failed");
    expect(v.error?.message).to.eq("disk gone");
  });

  it("still appends the other arguments around the error", async () => {
    const log = DI.resolve(Log, ["ea-extra"]);
    await log.warn("read failed", new Error("disk gone"), "extra");
    await log.warn("read failed", "extra", new Error("disk gone"));

    for (const v of sink().getRecords().map((r) => r.Variables)) {
      expect(v.message).to.eq("read failed extra");
      expect(v.error?.message).to.eq("disk gone");
    }
  });

  it("writes only the first of two trailing errors", async () => {
    const log = DI.resolve(Log, ["ea-two"]);
    await log.warn("read failed", new Error("disk gone"), new Error("second"));

    const v = only();
    expect(v.error?.message).to.eq("disk gone");
    expect(v.message).to.eq("read failed {}");
  });

  it("leaves an error that a placeholder consumes as a format argument", async () => {
    const log = DI.resolve(Log, ["ea-placeholder"]);
    await log.warn("read failed: %s", new Error("disk gone"));

    const v = only();
    expect(v.error).to.eq(undefined);
    expect(v.message).to.eq("read failed: {}");
  });

  it("keeps printing the enumerable fields of a trailing error", async () => {
    class HttpError extends Error {
      public status = 404;
    }
    const log = DI.resolve(Log, ["ea-enumerable"]);
    await log.warn("read failed", new HttpError("not found"));

    const v = only();
    expect(v.message).to.eq('read failed {"status":404}');
    expect(v.error?.message).to.eq("not found");
  });

  it("keeps printing the toJSON output of a trailing error", async () => {
    class CodedError extends Error {
      public toJSON() {
        return { code: "E_DISK" };
      }
    }
    const log = DI.resolve(Log, ["ea-tojson"]);
    await log.warn("read failed", new CodedError("disk gone"));

    const v = only();
    expect(v.message).to.eq('read failed {"code":"E_DISK"}');
    expect(v.error?.message).to.eq("disk gone");
  });

  it("keeps printing the field name and code of a trailing InvalidArgument", async () => {
    const log = DI.resolve(Log, ["ea-invalid-argument"]);
    await log.warn("bad option", new InvalidArgument("port out of range", "port", "E1"));

    const v = only();
    expect(v.message).to.eq('bad option {"fieldName":"port","errorCode":"E1"}');
    expect(v.error?.message).to.eq("port out of range");
    expect(format(v, DEFAULT_LAYOUT)).to.eq('WARN bad option {"fieldName":"port","errorCode":"E1"} Exception: port out of range (ea-invalid-argument)');
  });

  it("writes a trailing error of the fields form unless the fields carry their own", async () => {
    const log = DI.resolve(Log, ["ea-fields"]);
    await log.warn({ id: 7 }, "read ${id} failed", new Error("disk gone"));
    await log.warn({ error: new Error("own") }, "read failed", new Error("disk gone"));

    const [trailing, own] = sink().getRecords().map((r) => r.Variables);
    expect(trailing.message).to.eq("read 7 failed");
    expect(trailing.error?.message).to.eq("disk gone");
    expect(own.error?.message).to.eq("own");
  });

  it("does not change the error-first and fields-with-error calls", async () => {
    const log = DI.resolve(Log, ["ea-unchanged"]);
    await log.warn(new Error("disk gone"), "read %s failed", "a.txt");
    await log.warn({ error: new Error("disk gone"), id: 7 }, "read ${id} failed");

    const [first, fields] = sink().getRecords().map((r) => r.Variables);
    expect(format(first, DEFAULT_LAYOUT)).to.eq("WARN read a.txt failed Exception: disk gone (ea-unchanged)");
    expect(format(fields, DEFAULT_LAYOUT)).to.eq("WARN read 7 failed Exception: disk gone (ea-unchanged)");
    expect(fields.id).to.eq(7);
  });
});
