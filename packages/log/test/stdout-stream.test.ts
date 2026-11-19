import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { createLogMessageObject, IColoredConsoleTargetOptions, setLogStdoutStream } from "@spinajs/log-common";
import { ColoredConsoleTarget, IJsonTargetOptions, JsonTarget, LogLevel } from "../src/index.js";

const JSON_OPTIONS: IJsonTargetOptions = { name: "Json", type: "JsonTarget", layout: "${message}", enabled: true };
const THEME = { security: "red", fatal: "red", error: "red", warn: "yellow", success: "green", info: "white", debug: "gray", trace: "gray" };
const CONSOLE_OPTIONS: IColoredConsoleTargetOptions = { name: "Console", type: "ConsoleTarget", layout: "${message}", enabled: true, theme: THEME };

const entry = (level: LogLevel) => createLogMessageObject("hi", "", level, "stdout-stream", {});

describe("log lines meant for stdout and setLogStdoutStream()", () => {
  afterEach(() => {
    sinon.restore();
    setLogStdoutStream("stdout");
  });

  it("JsonTarget writes them to stderr once the stream is stderr", () => {
    const stdout = sinon.stub(process.stdout, "write");
    const stderr = sinon.stub(process.stderr, "write");

    setLogStdoutStream("stderr");
    new JsonTarget(JSON_OPTIONS).write(entry(LogLevel.Info));
    sinon.restore();

    expect(stdout.called).to.eq(false);
    expect(stderr.callCount).to.eq(1);
    expect(stderr.firstCall.args[0]).to.contain('"message":"hi"');
  });

  it("ColoredConsoleTarget writes info, success and debug with console.error once the stream is stderr", async () => {
    const log = sinon.stub(console, "log");
    const debug = sinon.stub(console, "debug");
    const error = sinon.stub(console, "error");
    const target = new ColoredConsoleTarget(CONSOLE_OPTIONS);
    await target.resolve();

    setLogStdoutStream("stderr");
    for (const level of [LogLevel.Info, LogLevel.Success, LogLevel.Debug]) {
      await target.write(entry(level));
    }
    sinon.restore();

    expect(log.called).to.eq(false);
    expect(debug.called).to.eq(false);
    expect(error.callCount).to.eq(3);
  });

  it("both targets write to stdout as before when the stream was never changed", async () => {
    const stdout = sinon.stub(process.stdout, "write");
    const log = sinon.stub(console, "log");
    const target = new ColoredConsoleTarget(CONSOLE_OPTIONS);
    await target.resolve();

    new JsonTarget(JSON_OPTIONS).write(entry(LogLevel.Info));
    await target.write(entry(LogLevel.Info));
    sinon.restore();

    expect(stdout.callCount).to.eq(1);
    expect(log.callCount).to.eq(1);
  });
});
