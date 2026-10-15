import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { AccessPushTransport } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { AccessController, SSE_RETRY_MS, SseAccessPushTransport } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

interface OpenStream {
  readonly res: http.IncomingMessage;
  /** The next frame without its blank-line terminator. */
  frame(ms?: number): Promise<string>;
  close(): void;
}

function openStream(app: TestApp, headers: Record<string, string>): Promise<OpenStream> {
  const { port } = app.server.Server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/user/access/events', headers }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      const frames: string[] = [];
      const waiting: ((frame: string) => void)[] = [];
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const next = waiting.shift();
          if (next) next(frame);
          else frames.push(frame);
        }
      });
      const frame = (ms = 2000) =>
        frames.length > 0
          ? Promise.resolve(frames.shift()!)
          : new Promise<string>((ok, fail) => {
              const timer = setTimeout(() => fail(new Error(`no frame within ${ms} ms`)), ms);
              waiting.push((f) => {
                clearTimeout(timer);
                ok(f);
              });
            });
      resolve({ res, frame, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /user/access/events (SSE, design §10.4)', function () {
  this.timeout(30000);

  let app: TestApp;
  let transport: SseAccessPushTransport;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [AccessController] });
    transport = (await DI.resolve(SseAccessPushTransport)) as SseAccessPushTransport;
  });

  after(async () => {
    await stopApp();
    unregisterSource();
  });

  it('is the AccessPushTransport named sse the router finds', async () => {
    const transports = (await DI.resolve(Array.ofType(AccessPushTransport))) as AccessPushTransport[];
    expect(transports).to.include(transport);
    expect(transport.name).to.eq('sse');
  });

  it('answers an uncompressed, unbuffered text/event-stream that starts with a retry line', async () => {
    const s = await openStream(app, { 'x-user': 'alice', 'accept-encoding': 'gzip, deflate, br' });
    try {
      expect(s.res.statusCode).to.eq(200);
      expect(s.res.headers['content-type']).to.match(/^text\/event-stream/);
      expect(s.res.headers['cache-control']).to.include('no-transform');
      expect(s.res.headers['x-accel-buffering']).to.eq('no');
      expect(s.res.headers['content-encoding']).to.eq(undefined);
      expect(s.res.headers['x-access-epoch']).to.match(/^[0-9a-f]{16}$/);
      expect(await s.frame()).to.eq(`retry: ${SSE_RETRY_MS}`);
    } finally {
      s.close();
    }
  });

  it("pushes authz.changed to the named principals' streams, and '*' to every stream", async () => {
    const alice = await openStream(app, { 'x-user': 'alice' });
    const bob = await openStream(app, { 'x-user': 'bob' });
    try {
      await alice.frame();
      await bob.frame();

      await transport.push(['user:alice'], { objects: [{ type: 'doc', id: '1' }] });
      await transport.push(['user:carol'], { objects: [{ type: 'doc', id: '2' }] });
      await transport.push('*', {});

      expect(await alice.frame()).to.eq('event: authz.changed\ndata: {"objects":[{"type":"doc","id":"1"}]}');
      expect(await alice.frame()).to.eq('event: authz.changed\ndata: {}');
      // bob's first event is the broadcast: neither alice's nor carol's push reached him
      expect(await bob.frame()).to.eq('event: authz.changed\ndata: {}');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('sends a heartbeat comment', async () => {
    transport.heartbeatMs = 50;
    const s = await openStream(app, { 'x-user': 'alice' });
    try {
      await s.frame();
      expect(await s.frame()).to.eq(': heartbeat');
    } finally {
      s.close();
      transport.heartbeatMs = 25_000;
    }
  });

  it('forgets a stream once the client goes away', async () => {
    const s = await openStream(app, { 'x-user': 'dave' });
    await s.frame();
    expect(transport.count('user:dave')).to.eq(1);

    s.close();
    await until(() => transport.count('user:dave') === 0);
  });

  it('answers 401 without a principal', async () => {
    testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
    try {
      const s = await openStream(app, {});
      expect(s.res.statusCode).to.eq(401);
      s.close();
    } finally {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
    }
  });

  // Last: it stops the app.
  it('ends the open streams when the http server stops', async () => {
    const s = await openStream(app, { 'x-user': 'alice' });
    await s.frame();
    const ended = new Promise<void>((resolve) => s.res.once('end', () => resolve()));

    const started = Date.now();
    await stopApp();
    await ended;
    expect(Date.now() - started).to.be.below(5000);
    expect(transport.count()).to.eq(0);
  });
});
