import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import { TestConfiguration } from "./common.js";
import { configuredCookieParser, resetCookieParser } from "../src/cookie.js";

/**
 * `res.cookie(..., { signed: true })` throws
 * `cookieParser("secret") required for signed cookies` unless cookie-parser was
 * constructed WITH a secret - that is what puts `req.secret` in place. Logging in
 * sets a signed `ssid` cookie, so a secretless parser breaks auth outright.
 */
describe("configured cookie parser", () => {
  beforeEach(async () => {
    DI.clearCache();
    resetCookieParser();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    DI.clearCache();
    resetCookieParser();
  });

  function run(): Record<string, any> {
    const req: Record<string, any> = { headers: { cookie: "" } };
    configuredCookieParser(req as any, {} as any, () => undefined);
    return req;
  }

  it("binds the configured http.cookie.secret so signed cookies work", () => {
    DI.get(Configuration)!.set("http.cookie.secret", "a-configured-secret");
    expect(run().secret).to.equal("a-configured-secret");
  });

  it("picks up an app-provided secret rather than freezing the shipped default", () => {
    DI.get(Configuration)!.set("http.cookie.secret", "app-override");
    expect(run().secret).to.equal("app-override");
  });

  it("falls back to an unsigned parser instead of throwing when no secret is configured", () => {
    // misconfiguration should degrade to unsigned cookies, not crash every request
    expect(() => run()).to.not.throw();
  });
});
