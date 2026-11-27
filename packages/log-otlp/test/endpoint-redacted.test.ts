import "mocha";
import { expect } from "chai";
import { createServer, IncomingHttpHeaders, Server } from "node:http";
import { inspect } from "node:util";
import { LogLevel } from "@spinajs/log";
import { ResiliencePipelineBuilder } from "@spinajs/util";

import { OtlpLogTarget } from "../src/index.js";

const SECRET = "planted-secret";
const TOKEN = "planted-token";
const HEADER = "planted-header";
const BASIC = Buffer.from(`user:${SECRET}`).toString("base64");

const plantedEndpoint = (port: number): string => `http://user:${SECRET}@127.0.0.1:${port}/v1/logs?token=${TOKEN}`;

class ProbeTarget extends OtlpLogTarget {
  public override resolve(): void {
    super.resolve();
    // The default pipeline backs off for seconds before it gives up on a refused connection.
    this.RetryPipeline = new ResiliencePipelineBuilder<void>().build();
  }
}

// No axios message quotes the URL today, so the interceptor makes the failure's message quote the endpoint.
class QuotingTarget extends ProbeTarget {
  public static quote: (endpoint: string) => string = (endpoint) => endpoint;

  public override resolve(): void {
    super.resolve();
    this.AxiosInstance.interceptors.response.use(undefined, (error: unknown) => {
      if (error instanceof Error) error.message = `${error.message} at ${QuotingTarget.quote(this.Options.endpoint)}`;
      throw error;
    });
  }
}

type Call = [level: string, ...args: unknown[]];

function captureLog(target: OtlpLogTarget): Call[] {
  const calls: Call[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push([level, ...args]);
    };
  // @Logger injection does not run for a direct `new`.
  Object.defineProperty(target, "Log", {
    configurable: true,
    value: { trace: at("trace"), debug: at("debug"), info: at("info"), success: at("success"), warn: at("warn"), error: at("error"), fatal: at("fatal"), security: at("security") },
  });
  return calls;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the listener has no port");
  return address.port;
}

async function listen(status: number): Promise<{ port: number; requests: IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: portOf(server), requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function closedPort(): Promise<number> {
  const listener = await listen(200);
  await listener.close();
  return listener.port;
}

async function ship(endpoint: string, Target: typeof ProbeTarget = ProbeTarget): Promise<{ calls: Call[]; stored: unknown; text: string }> {
  const target = new Target({ name: "Otlp", type: "OtlpLogTarget", layout: "${message}", enabled: true, endpoint, headers: { "x-api-key": HEADER }, interval: 100000, bufferSize: 100000, timeout: 1000 });
  const calls = captureLog(target);
  target.resolve();
  target.write({ Level: LogLevel.Info, Variables: { error: undefined, level: "INFO", logger: "app", message: "hello" } });
  await target.forceFlush();
  const stored = target.Error;
  await target.dispose();
  return { calls, stored, text: inspect([calls, stored, target.Error], { depth: 6, showHidden: true }) };
}

function expectNoCredential(text: string): void {
  for (const planted of [SECRET, TOKEN, HEADER, BASIC]) expect(text).to.not.include(planted);
}

const TRACE = "Wrote buffered messages to OTLP target at ${endpoint}, ${records} records.";
const RETAINED = "Cannot export log records to OTLP target - retries exhausted, retaining records for next flush.";
const DROPPED = "Cannot export log records to OTLP target - dropping ${records} records because the error is non-retryable or the target is disposed.";

describe("OtlpLogTarget logs its endpoint without credentials", () => {
  it("prints the endpoint redacted after a successful export", async () => {
    const listener = await listen(200);
    try {
      const { calls, text } = await ship(plantedEndpoint(listener.port));
      expectNoCredential(text);
      expect(calls).to.deep.eq([["trace", { endpoint: `http://127.0.0.1:${listener.port}/v1/logs`, records: 1 }, TRACE]]);
      expect(listener.requests).to.have.length(1);
      expect(listener.requests[0].authorization).to.eq(`Basic ${BASIC}`);
      expect(listener.requests[0]["x-api-key"]).to.eq(HEADER);
    } finally {
      await listener.close();
    }
  });

  it("logs the status of a rejected export, not the error with its request", async () => {
    const listener = await listen(401);
    try {
      const { calls, stored, text } = await ship(plantedEndpoint(listener.port));
      expectNoCredential(text);
      expect(calls).to.deep.eq([["error", { error: { name: "AxiosError", message: "Request failed with status code 401", code: "ERR_BAD_REQUEST", status: 401 }, records: 1 }, DROPPED]]);
      expect(stored).to.be.instanceOf(Error).and.include({ message: "Request failed with status code 401", status: 401 });
      expect(listener.requests).to.have.length(1);
      expect(listener.requests[0].authorization).to.eq(`Basic ${BASIC}`);
      expect(listener.requests[0]["x-api-key"]).to.eq(HEADER);
    } finally {
      await listener.close();
    }
  });

  it("logs the code of a refused connection, not the error with its request", async () => {
    const port = await closedPort();
    const { calls, text } = await ship(plantedEndpoint(port));
    expectNoCredential(text);
    const error = { name: "Error", message: `connect ECONNREFUSED 127.0.0.1:${port}`, code: "ECONNREFUSED" };
    expect(calls).to.deep.eq([
      ["error", { error }, RETAINED],
      ["error", { error, records: 1 }, DROPPED],
    ]);
  });

  it("never prints an endpoint that does not parse", async () => {
    const { calls, text } = await ship(plantedEndpoint(99999));
    expectNoCredential(text);
    const error = { name: "TypeError", message: "Invalid URL", code: "ERR_INVALID_URL" };
    expect(calls).to.deep.eq([
      ["error", { error }, RETAINED],
      ["error", { error, records: 1 }, DROPPED],
    ]);
  });

  it("redacts a failure message that quotes the endpoint", async () => {
    const listener = await listen(401);
    try {
      QuotingTarget.quote = (endpoint) => endpoint;
      const { calls, stored, text } = await ship(plantedEndpoint(listener.port), QuotingTarget);
      expectNoCredential(text);
      const message = `Request failed with status code 401 at http://127.0.0.1:${listener.port}/v1/logs`;
      expect(calls).to.deep.eq([["error", { error: { name: "AxiosError", message, code: "ERR_BAD_REQUEST", status: 401 }, records: 1 }, DROPPED]]);
      expect(stored).to.be.instanceOf(Error).and.include({ message });
    } finally {
      await listener.close();
    }
  });

  it("redacts a failure message that quotes an endpoint that does not parse, cut short", async () => {
    QuotingTarget.quote = (endpoint) => endpoint.slice(0, 40);
    const { calls, stored, text } = await ship(plantedEndpoint(99999), QuotingTarget);
    expectNoCredential(text);
    const error = { name: "TypeError", message: "Invalid URL at <not a URL>", code: "ERR_INVALID_URL" };
    expect(calls).to.deep.eq([
      ["error", { error }, RETAINED],
      ["error", { error, records: 1 }, DROPPED],
    ]);
    expect(stored).to.be.instanceOf(Error).and.include({ message: error.message });
  });
});
