import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { AccessPushTransport } from '@spinajs/authz';
import { AuthnEventSink, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';
import { testHost } from '@spinajs/authz-testing';

import { AccessController, SSE_RETRY_MS, SseAccessPushTransport } from '../src/index.js';
import { SseSessionEndSink } from '../src/authn/index.js';
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

const ended = (s: OpenStream) => (s.res.readableEnded ? Promise.resolve() : new Promise<void>((resolve) => s.res.once('end', () => resolve())));

/** Lists `live[id]` as the only sessions of an identity; nothing else of the issuer is used. */
class ListOnlySessions extends SessionIssuer {
  public static live: Record<string, string[]> = {};
  public static asked: IdentityRef[] = [];
  public issue(): never {
    throw new Error('unused');
  }
  public restore(): never {
    throw new Error('unused');
  }
  public rotate(): never {
    throw new Error('unused');
  }
  public elevate(): never {
    throw new Error('unused');
  }
  public reissue(): never {
    throw new Error('unused');
  }
  public set(): never {
    throw new Error('unused');
  }
  public revoke(): never {
    throw new Error('unused');
  }
  public revokeAll(): never {
    throw new Error('unused');
  }
  public revokeHandle(): never {
    throw new Error('unused');
  }
  public revokeByExternal(): never {
    throw new Error('unused');
  }
  public async list(subject: IdentityRef) {
    ListOnlySessions.asked.push(subject);
    return (ListOnlySessions.live[subject.id] ?? []).map((handle) => ({ handle, createdAt: new Date(0), lastSeenAt: new Date(0) }));
  }
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

  it('answers 401 for the anonymous principal: the stream needs an authenticated one, as the socket transport does', async () => {
    const s = await openStream(app, {});
    expect(s.res.statusCode).to.eq(401);
    s.close();
  });

  it('closes the oldest stream of a principal past authz.http.events.maxStreamsPerPrincipal', async () => {
    testHost.config().set(['authz', 'http', 'events', 'maxStreamsPerPrincipal'], 2);
    const opened: OpenStream[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        opened.push(await openStream(app, { 'x-user': 'erin' }));
        await opened[i].frame();
      }
      await ended(opened[0]);
      expect(transport.count('user:erin')).to.eq(2);
      expect(opened[1].res.readableEnded).to.eq(false);

      const other = await openStream(app, { 'x-user': 'frank' });
      opened.push(other);
      await other.frame();
      expect(transport.count('user:erin'), "another principal's stream closes none of erin's").to.eq(2);
    } finally {
      for (const s of opened) s.close();
      testHost.config().set(['authz', 'http', 'events', 'maxStreamsPerPrincipal'], 5);
    }
  });

  it('closes the streams of a session when authn reports its end, and only those', async () => {
    const sink = ((await DI.resolve(Array.ofType(AuthnEventSink))) as AuthnEventSink[]).find((s) => s instanceof SseSessionEndSink)!;
    expect(sink, 'SseSessionEndSink is a registered AuthnEventSink').to.not.eq(undefined);
    const event = (type: AuthnEvent['type'], id: string, session?: string): AuthnEvent => ({ type, at: new Date(), outcome: 'success', identity: { type: 'user', id }, ...(session ? { session } : {}) });

    const h1 = await openStream(app, { 'x-user': 'gina', 'x-session': 'h1' });
    const h2 = await openStream(app, { 'x-user': 'gina', 'x-session': 'h2' });
    const other = await openStream(app, { 'x-user': 'hank', 'x-session': 'h1' });
    const token = await openStream(app, { 'x-user': 'gina' });
    try {
      for (const s of [h1, h2, other, token]) await s.frame();

      await sink.publish({ ...event('logout', 'gina', 'h1'), outcome: 'failure' });
      await sink.publish(event('login', 'gina', 'h1'));
      expect(transport.count('user:gina'), 'a failed logout or a login ends nothing').to.eq(3);

      await sink.publish(event('logout', 'gina', 'h1'));
      await ended(h1);
      expect(transport.count('user:gina')).to.eq(2);
      expect(transport.count('user:hank'), 'the same handle of another principal stays').to.eq(1);

      await sink.publish(event('session.revoke', 'gina', 'h2'));
      await ended(h2);
      expect(transport.count('user:gina'), 'a stream without a session stays').to.eq(1);
    } finally {
      for (const s of [h1, h2, other, token]) s.close();
    }
  });

  it('re-checks the sessions of a principal against the SessionIssuer when a revoke names no session', async () => {
    const sink = ((await DI.resolve(Array.ofType(AuthnEventSink))) as AuthnEventSink[]).find((s) => s instanceof SseSessionEndSink)!;
    DI.register(ListOnlySessions).as(SessionIssuer);
    ListOnlySessions.live = { ivy: ['h2'] };
    ListOnlySessions.asked = [];
    const h1 = await openStream(app, { 'x-user': 'ivy', 'x-session': 'h1' });
    const h2 = await openStream(app, { 'x-user': 'ivy', 'x-session': 'h2' });
    const h3 = await openStream(app, { 'x-user': 'ivy', 'x-session': 'h3' });
    try {
      for (const s of [h1, h2, h3]) await s.frame();

      await sink.publish({ type: 'session.revoke', at: new Date(), outcome: 'success', identity: { type: 'user', id: 'ivy' }, data: { count: 2 } });
      await Promise.all([ended(h1), ended(h3)]);
      expect(transport.count('user:ivy')).to.eq(1);
      expect(h2.res.readableEnded).to.eq(false);
      expect(ListOnlySessions.asked).to.deep.equal([{ type: 'user', id: 'ivy' }]);
    } finally {
      for (const s of [h1, h2, h3]) s.close();
      DI.unregister(ListOnlySessions);
      DI.uncache(ListOnlySessions);
      DI.uncache(SessionIssuer);
    }
  });

  it('ends a stream whose session was rotated before the logout: the stale handle is re-checked against the SessionIssuer', async () => {
    const sink = ((await DI.resolve(Array.ofType(AuthnEventSink))) as AuthnEventSink[]).find((s) => s instanceof SseSessionEndSink)!;
    DI.register(ListOnlySessions).as(SessionIssuer);
    // h0 became h0r on a role switch (no event), then h0r logged out; h9 is another live session.
    ListOnlySessions.live = { jill: ['h9'] };
    ListOnlySessions.asked = [];
    const stale = await openStream(app, { 'x-user': 'jill', 'x-session': 'h0' });
    const other = await openStream(app, { 'x-user': 'jill', 'x-session': 'h9' });
    try {
      for (const s of [stale, other]) await s.frame();

      await sink.publish({ type: 'logout', at: new Date(), outcome: 'success', identity: { type: 'user', id: 'jill' }, session: 'h0r' });
      await ended(stale);
      expect(transport.count('user:jill')).to.eq(1);
      expect(other.res.readableEnded).to.eq(false);
    } finally {
      for (const s of [stale, other]) s.close();
      DI.unregister(ListOnlySessions);
      DI.uncache(ListOnlySessions);
      DI.uncache(SessionIssuer);
    }
  });

  it("ends the impersonation's streams on impersonation.end whose session is the impersonator's new one, and the actor's revoked ones on start", async () => {
    const sink = ((await DI.resolve(Array.ofType(AuthnEventSink))) as AuthnEventSink[]).find((s) => s instanceof SseSessionEndSink)!;
    DI.register(ListOnlySessions).as(SessionIssuer);
    const target = { type: 'user', id: 'kate' } as const;
    const actor = { type: 'user', id: 'liam' } as const;
    const before = await openStream(app, { 'x-user': 'liam', 'x-session': 'a0' });
    const own = await openStream(app, { 'x-user': 'kate', 'x-session': 'k1' });
    const opened = [before, own];
    try {
      for (const s of opened) await s.frame();

      // ImpersonationService.start revokes a0 and publishes the impersonation session's handle.
      ListOnlySessions.live = { kate: ['k1', 'imp'], liam: [] };
      await sink.publish({ type: 'impersonation.start', at: new Date(), outcome: 'success', identity: target, actor, session: 'imp' });
      await ended(before);
      expect(own.res.readableEnded, "the target's own session stays").to.eq(false);

      const imp = await openStream(app, { 'x-user': 'kate', 'x-session': 'imp' });
      opened.push(imp);
      await imp.frame();

      // stop revokes imp and publishes the impersonator's new session a1.
      ListOnlySessions.live = { kate: ['k1'], liam: ['a1'] };
      const after = await openStream(app, { 'x-user': 'liam', 'x-session': 'a1' });
      opened.push(after);
      await after.frame();
      await sink.publish({ type: 'impersonation.end', at: new Date(), outcome: 'success', identity: target, actor, session: 'a1' });
      await ended(imp);
      expect(transport.count('user:kate')).to.eq(1);
      expect(after.res.readableEnded, "the impersonator's new session, named by the event, stays").to.eq(false);
      expect(own.res.readableEnded).to.eq(false);
    } finally {
      for (const s of opened) s.close();
      DI.unregister(ListOnlySessions);
      DI.uncache(ListOnlySessions);
      DI.uncache(SessionIssuer);
    }
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

  it('dispose() ends the open streams and stops listening for the server shutdown', async () => {
    const s = await openStream(app, { 'x-user': 'alice' });
    await s.frame();
    const listeners = DI.RootContainer.listenerCount('http.server.closing');

    await transport.dispose();
    await ended(s);
    expect(transport.count()).to.eq(0);
    expect(DI.RootContainer.listenerCount('http.server.closing')).to.eq(listeners - 1);
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
