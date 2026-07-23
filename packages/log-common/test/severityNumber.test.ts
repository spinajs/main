import "mocha";
import { expect } from "chai";
import { LogLevel, LogLevelToSeverityNumber } from "../src/index.js";

describe("LogLevelToSeverityNumber", () => {
  it("maps each level to the expected OTel SeverityNumber", () => {
    expect(LogLevelToSeverityNumber[LogLevel.Trace]).to.eq(1);
    expect(LogLevelToSeverityNumber[LogLevel.Debug]).to.eq(5);
    expect(LogLevelToSeverityNumber[LogLevel.Info]).to.eq(9);
    expect(LogLevelToSeverityNumber[LogLevel.Success]).to.eq(11);
    expect(LogLevelToSeverityNumber[LogLevel.Warn]).to.eq(13);
    expect(LogLevelToSeverityNumber[LogLevel.Error]).to.eq(17);
    expect(LogLevelToSeverityNumber[LogLevel.Fatal]).to.eq(21);
    expect(LogLevelToSeverityNumber[LogLevel.Security]).to.eq(23);
  });

  it("is monotonic ( strictly increasing ) along severity order", () => {
    const severityOrder = [LogLevel.Trace, LogLevel.Debug, LogLevel.Info, LogLevel.Success, LogLevel.Warn, LogLevel.Error, LogLevel.Fatal, LogLevel.Security];

    for (let i = 1; i < severityOrder.length; i++) {
      expect(LogLevelToSeverityNumber[severityOrder[i]]).to.be.greaterThan(LogLevelToSeverityNumber[severityOrder[i - 1]]);
    }
  });
});
