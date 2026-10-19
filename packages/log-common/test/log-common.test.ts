import "mocha";
import { expect } from "chai";
import { Log } from "../src/index.js";

describe("Log.clearLoggers", () => {
  it("awaits disposal of internal loggers and forgets them", async () => {
    let disposed = false;
    const internal = {
      dispose: () => new Promise<void>((resolve) => setTimeout(() => ((disposed = true), resolve()), 5)),
    } as unknown as Log;
    Log.InternalLoggers.set("boot", internal);

    await Log.clearLoggers();

    expect(disposed).to.equal(true);
    expect(Log.InternalLoggers.size).to.equal(0);
  });
});
