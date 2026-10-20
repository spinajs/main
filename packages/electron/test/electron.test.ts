import "mocha";
import { expect } from "chai";
import { DI, Singleton } from "@spinajs/di";
import { Orm } from "@spinajs/orm";
import { Log } from "@spinajs/log-common";
import { AuthzService, AuthzDomains, DefaultAuthzDomains, SYSTEM } from "@spinajs/authz";
import type { Principal } from "@spinajs/authz";
import { callOnOrmConnection, callService, callServiceSync } from "../src/ipc-calls.js";
// Brings the window.ipc global declaration into the type-checked program.
import type {} from "../src/renderer.js";
import { ElectronRendererLogger } from "../src/electronRendererLogger.js";

const runs: Array<{ principal: Principal; reason: string }> = [];

@Singleton()
class FakeAuthz extends (AuthzService as any) {
  public domain = "root";

  public runAs(principal: Principal, reason: string, fn: () => Promise<unknown>) {
    runs.push({ principal, reason });
    return fn();
  }
}

@Singleton()
class FakeOrm {
  public Connections = new Map<string, unknown>([["ok", { query: async (x: number) => x * 2 }], ["bad", { query: async () => Promise.reject(new Error("boom")) }]]);
}

class FakeLog extends (Log as any) {
  public trace() {}
  public error() {}
  public info() {}
}

class Greeter {
  public hello(name: string) {
    return `hello ${name}`;
  }

  public fail() {
    throw new Error("nope");
  }
}

async function registerAuthz() {
  DI.register(FakeAuthz).as(AuthzService);
  const fake = (await DI.resolve(AuthzService)) as unknown as AuthzService;
  const domains = (await DI.resolve(AuthzDomains)) as DefaultAuthzDomains;
  domains.enter(DI.RootContainer, fake);
  domains.attach("root", fake);
}

function unregisterAuthz() {
  DI.uncache(DefaultAuthzDomains);
  DI.uncache(AuthzDomains);
  DI.uncache(FakeAuthz);
  DI.uncache(AuthzService);
  DI.unregister(FakeAuthz);
}

describe("electron IPC calls", () => {
  before(async () => {
    DI.register(FakeLog).as(Log);
    DI.register(FakeOrm).as(Orm);
    DI.register(Greeter).as("Greeter");
    await DI.resolve(Orm);
  });

  after(() => {
    DI.unregister(FakeLog);
    DI.unregister(FakeOrm);
    DI.uncache(Orm);
    DI.uncache(Log);
    DI.uncache(FakeOrm);
    DI.uncache("Greeter");
    DI.unregister(Greeter);
  });

  beforeEach(() => {
    runs.length = 0;
  });

  describe("with an AuthzService", () => {
    before(registerAuthz);
    after(unregisterAuthz);

    it("callService runs as SYSTEM with reason electron-ipc", async () => {
      expect(await callService("hello", "Greeter", [], "x")).to.eq("hello x");
      expect(runs.length).to.eq(1);
      expect(runs[0].principal).to.equal(SYSTEM);
      expect(runs[0].reason).to.eq("electron-ipc");
    });

    it("callOnOrmConnection runs as SYSTEM with reason electron-ipc", async () => {
      expect(await callOnOrmConnection("ok", "query", 21)).to.eq(42);
      expect(runs.length).to.eq(1);
      expect(runs[0].principal).to.equal(SYSTEM);
      expect(runs[0].reason).to.eq("electron-ipc");
    });

    it("callService on Log does not call runAs (one audit entry per renderer log line otherwise)", async () => {
      await callService("info", "Log", ["renderer"], "a line");
      expect(runs.length).to.eq(0);
    });

    it("callServiceSync does not call runAs", () => {
      const event = { returnValue: undefined as unknown };
      callServiceSync(event, "hello", "Greeter", "y");
      expect(event.returnValue).to.eq("hello y");
      expect(runs.length).to.eq(0);
    });
  });

  describe("without an AuthzService", () => {
    it("callService and callOnOrmConnection still run", async () => {
      expect(await callService("hello", "Greeter", [], "z")).to.eq("hello z");
      expect(await callOnOrmConnection("ok", "query", 2)).to.eq(4);
      expect(runs.length).to.eq(0);
    });
  });

  describe("error paths", () => {
    it("callService throws for an unknown service", async () => {
      let err: Error | undefined;
      try {
        await callService("hello", "NoSuchService", []);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.match(/no service named: NoSuchService/);
    });

    it("callService throws for an unknown method", async () => {
      let err: Error | undefined;
      try {
        await callService("missing", "Greeter", []);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.match(/not found in service named: Greeter/);
    });

    it("callService throws a wrapped error when the method throws", async () => {
      let err: Error | undefined;
      try {
        await callService("fail", "Greeter", []);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.match(/cause: nope/);
    });

    it("callOnOrmConnection throws for an unknown connection and for a failing call", async () => {
      let err: Error | undefined;
      try {
        await callOnOrmConnection("none", "query");
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.match(/connection: none/);

      err = undefined;
      try {
        await callOnOrmConnection("bad", "query");
      } catch (e) {
        err = e as Error;
      }
      expect((err?.cause as Error).message).to.eq("boom");
    });

    it("callServiceSync reports an unknown method through returnValue", () => {
      const event = { returnValue: undefined as unknown };
      callServiceSync(event, "missing", "Greeter");
      expect(event.returnValue).to.be.instanceOf(Error);
    });

    it("callServiceSync reports an unknown service through returnValue", () => {
      const event = { returnValue: undefined as unknown };
      callServiceSync(event, "hello", "NoSuchService");
      expect(event.returnValue).to.be.instanceOf(Error);
      expect((event.returnValue as Error).message).to.match(/no service named: NoSuchService/);
    });
  });
});

describe("electron renderer logger", () => {
  after(() => {
    Log.Loggers.delete("renderer-a");
    Log.Loggers.delete("renderer-b");
  });

  it("gives each name its own logger and registers it in Log.Loggers", async () => {
    const a = await DI.resolve(ElectronRendererLogger, ["renderer-a"]);
    const b = await DI.resolve(ElectronRendererLogger, ["renderer-b"]);
    expect(a.Name).to.eq("renderer-a");
    expect(b.Name).to.eq("renderer-b");
    expect(Log.Loggers.get("renderer-a")).to.equal(a);
  });
});
