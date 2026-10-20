import "mocha";
import { expect } from "chai";
import { ILogEntry, Log, WARN_ONCE_MAX_KEYS } from "../src/index.js";

class RecordingLog extends Log {
  public lines: unknown[][] = [];

  constructor(name: string) {
    super();
    this.Name = name;
  }

  public warn(...args: unknown[]): void {
    this.lines.push(args);
  }

  public trace(): void {}
  public debug(): void {}
  public info(): void {}
  public success(): void {}
  public error(): void {}
  public fatal(): void {}
  public security(): void {}

  public write(_entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    return Promise.resolve([]);
  }
}

describe("Log.warnOnce", () => {
  afterEach(() => Log.clearLoggers());

  it("writes a key once per logger name, across instances of that name", () => {
    const first = new RecordingLog("pkg");
    const second = new RecordingLog("pkg");

    expect(first.warnOnce("a", "a ${x}", 1)).to.equal(true);
    expect(second.warnOnce("a", "a again")).to.equal(false);
    expect(second.warnOnce("b", { x: 1 }, "b ${x}")).to.equal(true);

    expect(first.lines).to.deep.equal([["a ${x}", 1]]);
    expect(second.lines).to.deep.equal([[{ x: 1 }, "b ${x}"]]);
  });

  it("keeps keys of different logger names apart", () => {
    const a = new RecordingLog("pkg-a");
    const b = new RecordingLog("pkg-b");

    expect(a.warnOnce("same", "from a")).to.equal(true);
    expect(b.warnOnce("same", "from b")).to.equal(true);
  });

  it("passes an error-form call through", () => {
    const log = new RecordingLog("pkg-err");
    const err = new Error("boom");

    log.warnOnce("e", err, "failed");

    expect(log.lines).to.deep.equal([[err, "failed"]]);
  });

  it("does not remember a key whose write threw", () => {
    const log = new RecordingLog("pkg-throw");
    const warn = log.warn.bind(log);
    log.warn = () => {
      throw new Error("target down");
    };

    expect(() => log.warnOnce("k", "w")).to.throw("target down");

    log.warn = warn;
    expect(log.warnOnce("k", "w")).to.equal(true);
  });

  it("forgets the oldest key past the cap", () => {
    const log = new RecordingLog("pkg-cap");
    for (let i = 0; i < WARN_ONCE_MAX_KEYS + 1; i++) {
      log.warnOnce(`k${i}`, "w");
    }

    expect(log.warnOnce("k0", "w")).to.equal(true);
    expect(log.warnOnce(`k${WARN_ONCE_MAX_KEYS}`, "w")).to.equal(false);
  });

  it("forgets every key on clearLoggers", async () => {
    const log = new RecordingLog("pkg-clear");
    log.warnOnce("k", "w");

    await Log.clearLoggers();

    expect(log.warnOnce("k", "w")).to.equal(true);
  });
});
