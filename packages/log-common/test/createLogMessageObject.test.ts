import "mocha";
import { expect } from "chai";
import { format } from "@spinajs/configuration-common";
import { createLogMessageObject, LogLevel } from "../src/index.js";

describe("createLogMessageObject serializer wiring", () => {
  it("serializes the `error` Error into a structured record on the entry", () => {
    const entry = createLogMessageObject(new Error("boom"), "msg", LogLevel.Error, "lg", {});

    expect(entry.Level).to.equal(LogLevel.Error);
    expect(entry.Variables.error).to.be.an("object");
    expect(entry.Variables.error).to.not.be.instanceOf(Error);

    const e = entry.Variables.error as { message: string; name: string };
    expect(e.message).to.equal("boom");
    expect(e.name).to.equal("Error");

    // static vars still present
    expect(entry.Variables.message).to.equal("msg");
    expect(entry.Variables.logger).to.equal("lg");
    expect(entry.Variables.level).to.equal("ERROR");
  });

  it("keeps ${error:message} rendering to the error message ( layout compatibility )", () => {
    const entry = createLogMessageObject(new Error("boom"), "msg", LogLevel.Error, "lg", {});
    const rendered = format(entry.Variables as any, "${error:message}");
    expect(rendered).to.equal("boom");
  });

  it("keeps ${?error}...${/error} truthy when an error is present", () => {
    const entry = createLogMessageObject(new Error("boom"), "msg", LogLevel.Error, "lg", {});
    const rendered = format(entry.Variables as any, "${?error}has-error${/error}");
    expect(rendered).to.equal("has-error");
  });

  it("renders the full default target layout end-to-end with a serialized error", () => {
    const layout = "${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})";
    const entry = createLogMessageObject(new Error("error message"), "hello world err", LogLevel.Error, "test-format", {});
    const rendered = format(entry.Variables as any, layout);

    // the ${?error} block renders and ${error:message} resolves to the message
    expect(rendered).to.contain("ERROR hello world err Exception: error message");
    expect(rendered).to.contain("(test-format)");
    // never leaks [object Object]
    expect(rendered).to.not.contain("[object Object]");
  });

  it("renders ${?error} block empty when there is no error", () => {
    const entry = createLogMessageObject("just a message", "msg", LogLevel.Info, "lg", {});
    expect(entry.Variables.error).to.equal(undefined);
    const rendered = format(entry.Variables as any, "${?error}has-error${/error}done");
    expect(rendered).to.equal("done");
  });
});
