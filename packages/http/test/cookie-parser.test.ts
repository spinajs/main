import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Configuration } from "@spinajs/configuration";
import { TestConfiguration } from "./common.js";
import httpConfig from "../src/config/http.js";

/**
 * `res.cookie(..., { signed: true })` throws
 * `cookieParser("secret") required for signed cookies` unless cookie-parser was
 * constructed WITH a secret - that is what puts `req.secret` in place. Logging in
 * sets a signed `ssid` cookie, so a secretless parser breaks auth outright.
 */
describe("cookie parser middleware", () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    DI.clearCache();
  });

  function runCookieMiddleware(secret?: string): Record<string, any> {
    const cfg = DI.get(Configuration)!;
    if (secret !== undefined) {
      cfg.set("http.cookie.secret", secret);
    }

    // the cookie middleware is the one that populates req.secret / req.cookies
    const middlewares = (httpConfig as any).http.middlewares as any[];
    const req: Record<string, any> = { headers: { cookie: "" } };

    for (const m of middlewares) {
      if (typeof m !== "function" || m.length !== 3) continue;
      try {
        m(req, {} as any, () => undefined);
      } catch {
        // unrelated middlewares may not tolerate the bare stub; only cookies matter
      }
      if (req.secret !== undefined) break;
    }

    return req;
  }

  it("binds the configured http.cookie.secret so signed cookies work", () => {
    const req = runCookieMiddleware("a-configured-secret");
    expect(req.secret).to.equal("a-configured-secret");
  });

  it("ships a usable default secret at http.cookie.secret", () => {
    const cfg = DI.get(Configuration)!;
    expect(cfg.get<string>("http.cookie.secret"), "default must live where every consumer reads it").to.be.a("string").and.not.empty;
  });
});
