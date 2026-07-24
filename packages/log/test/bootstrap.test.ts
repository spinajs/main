import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { LogBotstrapper } from "../src/index.js";

describe("LogBotstrapper", () => {
  const testingFlag = process.env.TESTING;

  before(() => {
    // the listener-registration path only runs when TESTING is not set
    delete process.env.TESTING;
  });

  after(() => {
    if (testingFlag !== undefined) {
      process.env.TESTING = testingFlag;
    }
    // clean up listeners we may have added
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
  });

  it("registers exactly one unhandledRejection listener across repeated bootstraps", () => {
    const bootstrapper = DI.resolve(LogBotstrapper);

    // start from a clean slate so the count is meaningful
    process.removeAllListeners("unhandledRejection");

    bootstrapper.bootstrap();
    bootstrapper.bootstrap();

    // the removeListener must reference the same handler that was added, otherwise
    // each bootstrap leaks another listener.
    expect(process.listenerCount("unhandledRejection")).to.eq(1);
  });
});
