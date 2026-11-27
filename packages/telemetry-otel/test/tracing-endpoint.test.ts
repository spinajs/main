import 'mocha';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { inspect } from 'node:util';
import { expect } from 'chai';
import { DEFAULT_TRACING_OPTIONS, ensureTracing } from '@spinajs/tracing';
import { resetTracing } from '@spinajs/tracing/testing';

import { OtelTracing } from '../src/tracing.js';
import { setField } from './support.js';

const SECRET = 'planted-secret';
const TOKEN = 'planted-token';

const plantedEndpoint = (port: number): string => `http://user:${SECRET}@127.0.0.1:${port}/v1/traces?token=${TOKEN}`;

interface Collector {
  server: Server;
  port: number;
  requests: Array<Pick<IncomingMessage, 'method' | 'url' | 'headers'>>;
}

async function collector(status: number): Promise<Collector> {
  const requests: Collector['requests'] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => res.writeHead(status, { 'content-type': 'application/json' }).end('{}'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the collector is not listening on a TCP port');
  return { server, port: address.port, requests };
}

async function closedPort(): Promise<number> {
  const { server, port } = await collector(200);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(target: Collector): Promise<void> {
  target.server.closeAllConnections();
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
}

interface Started {
  tracing: OtelTracing;
  /** Every log call, every level, with its fields and message template. */
  calls: unknown[][];
  /** Everything a log sink could print: the calls with their error objects expanded (message, stack, cause, own fields). */
  text: () => string;
}

function startTracing(endpoint: string): Started {
  const tracing = new OtelTracing();
  const calls: unknown[][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void =>
      void calls.push([level, ...args]);
  setField(tracing, 'enabled', true);
  setField(tracing, 'endpoint', endpoint);
  setField(tracing, 'log', { info: record('info'), warn: record('warn'), error: record('error') });
  setField(tracing, 'cfg', { get: (_path: string, fallback?: unknown) => fallback });
  tracing.start();
  return { tracing, calls, text: () => inspect(calls, { depth: 20, showHidden: true, breakLength: Infinity }) };
}

/** The error a flush rejects with, as the application that awaits it would see it. */
async function flushError(tracing: OtelTracing): Promise<unknown> {
  try {
    await tracing.flush();
    return undefined;
  } catch (err) {
    return err;
  }
}

function expectNoCredential(text: string): void {
  expect(text).to.not.contain(SECRET);
  expect(text).to.not.contain(TOKEN);
}

describe('OtelTracing endpoint in logs', () => {
  beforeEach(() => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'test-service' });
  });

  afterEach(() => resetTracing());

  it('logs the started line without userinfo and query, and exports to the configured collector', async () => {
    const target = await collector(200);
    const { tracing, calls, text } = startTracing(plantedEndpoint(target.port));
    try {
      expect(tracing.active).to.eq(true);
      await tracing.withSpan('unit.op', {}, async () => 'ok');
      expect(await flushError(tracing)).to.eq(undefined);
      expect(target.requests.map(({ method, url }) => [method, url])).to.deep.eq([['POST', '/v1/traces']]);
      expectNoCredential(text());
      expect(calls).to.deep.eq([['info', { endpoint: `http://127.0.0.1:${target.port}/v1/traces` }, 'otel export started (endpoint=${endpoint})']]);
    } finally {
      await tracing.dispose();
      await stop(target);
    }
  });

  it('keeps the credential out of the log and of the error when the collector answers 401', async () => {
    const target = await collector(401);
    const { tracing, text } = startTracing(plantedEndpoint(target.port));
    try {
      await tracing.withSpan('unit.op', {}, async () => 'ok');
      const flushed = await flushError(tracing);
      expect(flushed).to.be.instanceOf(Error);
      expectNoCredential(inspect(flushed, { depth: 20, showHidden: true }));
      // A span still queued at dispose fails its export there, and that error goes to the log.
      await tracing.withSpan('unit.last', {}, async () => 'ok');
      await tracing.dispose();
      expect(target.requests.map(({ url }) => url)).to.deep.eq(['/v1/traces', '/v1/traces']);
      expect(text()).to.contain('the spans still buffered at shutdown were not exported');
      expectNoCredential(text());
    } finally {
      await tracing.dispose();
      await stop(target);
    }
  });

  it('keeps the credential out of the log and of the error when the collector port is closed', async () => {
    const { tracing, text } = startTracing(plantedEndpoint(await closedPort()));
    try {
      await tracing.withSpan('unit.op', {}, async () => 'ok');
      const flushed = await flushError(tracing);
      expect(flushed).to.be.instanceOf(Error);
      expectNoCredential(inspect(flushed, { depth: 20, showHidden: true }));
      await tracing.withSpan('unit.last', {}, async () => 'ok');
      await tracing.dispose();
      expect(text()).to.contain('the spans still buffered at shutdown were not exported');
      expectNoCredential(text());
    } finally {
      await tracing.dispose();
    }
  });

  it('keeps the credential out of the error line when no exporter can be built for the endpoint', async () => {
    // Port 99999 does not parse, and the exporter's error message repeats the URL it refused.
    const { tracing, calls, text } = startTracing(plantedEndpoint(99999));
    expect(tracing.active).to.eq(false);
    expectNoCredential(text());
    expect(calls).to.deep.eq([['error', { endpoint: '<not a URL>' }, 'otel export not started: no OTLP exporter for ${endpoint}']]);
    await tracing.dispose();
  });
});
