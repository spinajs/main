import "mocha";
import { expect } from "chai";
import { createLogMessageObject, LogLevel } from "../src/index.js";

describe("createLogMessageObject with an error after the message", () => {
  it("takes an error left over after the placeholders as the entry's error", () => {
    const entry = createLogMessageObject("read %s failed", null as any, LogLevel.Warn, "lg", {}, "a.txt", new Error("disk gone"));

    expect(entry.Variables.message).to.eq("read a.txt failed");
    expect(entry.Variables.error?.message).to.eq("disk gone");
  });

  it("does not count %% as a placeholder", () => {
    const entry = createLogMessageObject("100%% read", null as any, LogLevel.Warn, "lg", {}, new Error("disk gone"));

    expect(entry.Variables.message).to.eq("100% read");
    expect(entry.Variables.error?.message).to.eq("disk gone");
  });

  it("leaves an error filled into a placeholder in the message", () => {
    const entry = createLogMessageObject("read failed: %j", null as any, LogLevel.Warn, "lg", {}, new Error("disk gone"));

    expect(entry.Variables.error).to.eq(undefined);
    expect(entry.Variables.message).to.eq("read failed: {}");
  });

  it("keeps an error the variables carry, even an undefined one", () => {
    const own = createLogMessageObject("read failed", null as any, LogLevel.Warn, "lg", { error: new Error("own") }, new Error("disk gone"));
    const cleared = createLogMessageObject("read failed", null as any, LogLevel.Warn, "lg", { error: undefined }, new Error("disk gone"));

    expect(own.Variables.error?.message).to.eq("own");
    expect(cleared.Variables.error).to.eq(undefined);
  });

  it("does not throw for primitive variables", () => {
    const entry = createLogMessageObject("read failed", null as any, LogLevel.Warn, "lg", "x", new Error("disk gone"));

    expect(entry.Variables.message).to.eq("read failed");
    expect(entry.Variables.error?.message).to.eq("disk gone");
  });

  it("does not throw for an argument whose prototype cannot be read", () => {
    const opaque = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      }
    );
    const entry = createLogMessageObject("read failed", null as any, LogLevel.Warn, "lg", {}, opaque);

    expect(entry.Variables.message).to.eq("read failed {}");
    expect(entry.Variables.error).to.eq(undefined);
  });

  it("does not take a plain object that only looks like an error", () => {
    const entry = createLogMessageObject("read failed", null as any, LogLevel.Warn, "lg", {}, { message: "disk gone" });

    expect(entry.Variables.message).to.eq('read failed {"message":"disk gone"}');
    expect(entry.Variables.error).to.eq(undefined);
  });

  it("keeps the first-argument error over a trailing one", () => {
    const entry = createLogMessageObject(new Error("first"), "read failed", LogLevel.Warn, "lg", {}, new Error("second"));

    expect(entry.Variables.error?.message).to.eq("first");
    expect(entry.Variables.message).to.eq("read failed {}");
  });
});
