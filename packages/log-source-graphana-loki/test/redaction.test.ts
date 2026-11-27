import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import dns from "node:dns";
import * as http from "node:http";
import { inspect } from "node:util";
import { AxiosInstance } from "axios";
import { ILogEntry, LogLevel } from "@spinajs/log";
import { ResiliencePipelineBuilder } from "@spinajs/util";

import { GraphanaLokiLogTarget, IGraphanaOptions } from "../src/index.js";

type Call = [level: string, ...args: unknown[]];

class CapturedLokiTarget extends GraphanaLokiLogTarget {
  public readonly calls: Call[] = [];

  constructor(options: IGraphanaOptions) {
    super(options);
    const record =
      (level: string) =>
      (...args: unknown[]) => {
        this.calls.push([level, ...args]);
      };
    // `Log` is an accessor installed by @Logger; a direct `new` gets no logger, so the test supplies one.
    Object.defineProperty(this, "Log", {
      configurable: true,
      value: Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal", "security", "success"].map((level) => [level, record(level)])),
    });
  }

  public resolve(): void {
    super.resolve();
    // One attempt: a refused or unparsable host then fails at once instead of after the backoff.
    this.RetryPipeline = new ResiliencePipelineBuilder<void>().build();
  }

  public push(batch: ILogEntry[]): Promise<void> {
    return this.send(batch);
  }

  public get http(): AxiosInstance {
    return this.AxiosInstance;
  }
}

interface Received {
  authorization?: string;
  url?: string;
}

interface Listener {
  port: number;
  received: Received[];
  close(): Promise<void>;
}

/** A local Loki stand-in answering `status`, or never answering for `"hang"`. */
async function listen(status: number | "hang"): Promise<Listener> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    received.push({ authorization: req.headers.authorization, url: req.url });
    req.resume();
    req.on("end", () => {
      if (status === "hang") return;
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the listener has no port");
  return {
    port: address.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function closedPort(): Promise<number> {
  const listener = await listen(204);
  await listener.close();
  return listener.port;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

interface Case {
  name: string;
  host: (authority: string) => string;
  auth?: IGraphanaOptions["auth"];
  planted: string[];
  authorization: string;
  path: string;
  logged: (authority: string) => string;
}

const TOKEN_SEGMENT = "planted-token-0123456789";

const CASES: Case[] = [
  {
    name: "userinfo in host",
    host: (authority) => `http://user:planted-secret@${authority}`,
    planted: ["planted-secret", Buffer.from("user:planted-secret").toString("base64")],
    authorization: basic("user", "planted-secret"),
    path: "/loki/api/v1/push",
    logged: (authority) => `http://${authority}/`,
  },
  {
    name: "auth options and a token in the host path",
    host: (authority) => `http://${authority}/${TOKEN_SEGMENT}`,
    auth: { username: "planted-user", password: "planted-password" },
    planted: ["planted-user", "planted-password", "planted-token", Buffer.from("planted-user:planted-password").toString("base64")],
    authorization: basic("planted-user", "planted-password"),
    path: `/${TOKEN_SEGMENT}/loki/api/v1/push`,
    logged: (authority) => `http://${authority}/***`,
  },
];

const local = (port: number) => `127.0.0.1:${port}`;

function target(host: string, auth?: IGraphanaOptions["auth"], timeout = 2000): CapturedLokiTarget {
  const t = new CapturedLokiTarget({
    name: "Graphana",
    type: "GraphanaLogTarget",
    enabled: true,
    layout: "${message}",
    interval: 100000,
    bufferSize: 100000,
    maxBufferSize: 1000,
    timeout,
    host,
    auth: auth ?? { username: "", password: "" },
    labels: { app: "redaction-test" },
  });
  t.resolve();
  return t;
}

const entry = (): ILogEntry => ({ Level: LogLevel.Info, Variables: { error: undefined, logger: "app", level: "INFO", message: "shipped", n_timestamp: Date.now() * 1000000 } });

function expectNothingPlanted(t: CapturedLokiTarget, planted: string[]): void {
  const seen = [inspect(t.calls, { depth: 6, showHidden: true }), inspect(t.Error, { depth: 6, showHidden: true })].join("\n");
  for (const value of planted) expect(seen, value).to.not.contain(value);
}

function onlyCall(t: CapturedLokiTarget, level: string): unknown {
  expect(t.calls.map(([l]) => l)).to.deep.eq([level]);
  return t.calls[0][1];
}

describe("loki target keeps credentials out of its own log", () => {
  afterEach(() => sinon.restore());

  for (const c of CASES) {
    describe(c.name, () => {
      it("logs a delivered batch with the host redacted", async () => {
        const listener = await listen(204);
        try {
          const t = target(c.host(local(listener.port)), c.auth);
          await t.push([entry()]);

          expect(listener.received).to.deep.eq([{ authorization: c.authorization, url: c.path }]);
          expectNothingPlanted(t, c.planted);
          expect(onlyCall(t, "trace")).to.deep.eq({ host: c.logged(local(listener.port)), messages: 1 });
        } finally {
          await listener.close();
        }
      });

      it("logs a rejected batch with its status, without the request", async () => {
        const listener = await listen(401);
        try {
          const t = target(c.host(local(listener.port)), c.auth);
          await t.push([entry()]);

          expect(listener.received).to.deep.eq([{ authorization: c.authorization, url: c.path }]);
          expect(t.HasError).to.eq(true);
          expectNothingPlanted(t, c.planted);
          const vars = onlyCall(t, "error");
          expect(vars).to.have.nested.property("error.status", 401);
          expect(vars).to.have.nested.property("error.name", "AxiosError");
          expect(vars).to.have.nested.property("error.message", "Request failed with status code 401");
          // A documented health check reads `target.Error instanceof Error ? target.Error.message : null`.
          expect(t.Error).to.be.instanceOf(Error).and.to.have.property("message", "Request failed with status code 401");
        } finally {
          await listener.close();
        }
      });

      it("logs a refused connection with its code", async () => {
        const t = target(c.host(local(await closedPort())), c.auth);
        await t.push([entry()]);

        expectNothingPlanted(t, c.planted);
        const vars = onlyCall(t, "error");
        expect(vars).to.have.nested.property("error.code", "ECONNREFUSED");
        expect(vars).to.not.have.nested.property("error.status");
      });

      it("logs a timeout with its code", async () => {
        const listener = await listen("hang");
        try {
          const t = target(c.host(local(listener.port)), c.auth, 300);
          await t.push([entry()]);

          expect(listener.received).to.deep.eq([{ authorization: c.authorization, url: c.path }]);
          expectNothingPlanted(t, c.planted);
          const vars = onlyCall(t, "error");
          expect(vars).to.have.nested.property("error.code", "ECONNABORTED");
          expect(vars).to.have.nested.property("error.message", "timeout of 300ms exceeded");
        } finally {
          await listener.close();
        }
      });

      it("logs a host that does not resolve with its code", async () => {
        // No DNS query leaves the machine: the lookup fails here, as the resolver does for an unknown name.
        const lookup = sinon.stub(dns, "lookup").yields(Object.assign(new Error("getaddrinfo ENOTFOUND loki.invalid"), { code: "ENOTFOUND" }));
        const t = target(c.host("loki.invalid"), c.auth);
        await t.push([entry()]);

        expect(lookup.called).to.eq(true);
        expectNothingPlanted(t, c.planted);
        const vars = onlyCall(t, "error");
        expect(vars).to.have.nested.property("error.code", "ENOTFOUND");
        expect(vars).to.have.nested.property("error.message", "getaddrinfo ENOTFOUND loki.invalid");
      });

      it("logs a host that does not parse without printing it", async () => {
        const t = target(c.host(local(99999)), c.auth);
        await t.push([entry()]);

        expectNothingPlanted(t, c.planted);
        const vars = onlyCall(t, "error");
        expect(vars).to.have.nested.property("error.name", "TypeError");
        expect(inspect(t.calls, { depth: 6 })).to.not.contain("99999");
      });
    });
  }

  it("prints the host a failure message repeats in its redacted form", async () => {
    const host = "http://user:planted-secret@127.0.0.1:1";
    const t = target(host);
    sinon.stub(t.http, "post").rejects(new Error(`push to ${host}/loki/api/v1/push failed`));
    await t.push([entry()]);

    expectNothingPlanted(t, ["planted-secret"]);
    expect(onlyCall(t, "error")).to.have.nested.property("error.message", "push to http://127.0.0.1:1/loki/api/v1/push failed");
  });
});
