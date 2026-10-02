import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import _ from 'lodash';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { SYSTEM_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketHub } from '../src/hub.js';
import { ISocketCallStorage, ISocketHandshake, SocketPrincipalSource, SocketRevalidationResult } from '../src/interfaces.js';
import { MAX_CONCURRENT_REVALIDATIONS, SocketPrincipalGuard } from '../src/principal-guard.js';
import { ALICE_PRINCIPAL, ITestServer, TestPrincipalSource, command, delay, errorOf, nextEvent, open, resultOf, startServer, waitFor } from './harness.js';

export const revalRevoked = new Set<string>();
export let revalChecks = 0;

/** Owns the tokens starting with 'reval-'. */
export class RevalSource extends SocketPrincipalSource {
  public readonly name = 'reval';
  public readonly order = 1;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('reval-')) {
      return null;
    }

    revalChecks++;
    if (revalRevoked.has(token)) {
      throw new AuthenticationFailed('revoked');
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {}, ...(token === 'reval-expiring' ? { ceiling: { expiresAt: new Date(Date.now() + 400) } } : {}) };
  }
}

/** Owns the tokens starting with 'revalthrow-'; its revalidate() cannot reach its store. */
export class RevalThrowingSource extends SocketPrincipalSource {
  public readonly name = 'reval-throwing';
  public readonly order = 2;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('revalthrow-')) {
      return null;
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {} };
  }

  public async revalidate(): Promise<boolean> {
    throw new Error('credential store unreachable');
  }
}

/** Owns the tokens starting with 'revalscript-'; revalidate() answers from `answers` ( 'valid' when empty ) once `gate` settles. */
export class RevalScriptedSource extends SocketPrincipalSource {
  public static answers: SocketRevalidationResult[] = [];
  public static gate: Promise<void> | null = null;
  public static calls = 0;
  public static active = 0;
  public static maxActive = 0;

  public static reset(): void {
    RevalScriptedSource.answers = [];
    RevalScriptedSource.gate = null;
    RevalScriptedSource.calls = 0;
    RevalScriptedSource.active = 0;
    RevalScriptedSource.maxActive = 0;
  }

  public readonly name = 'reval-scripted';
  public readonly order = 3;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('revalscript-')) {
      return null;
    }

    const ceiling = token === 'revalscript-expiring' ? { ceiling: { expiresAt: new Date(Date.now() + 90_000) } } : {};
    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {}, ...ceiling };
  }

  public async revalidate(): Promise<SocketRevalidationResult> {
    RevalScriptedSource.calls++;
    RevalScriptedSource.active++;
    RevalScriptedSource.maxActive = Math.max(RevalScriptedSource.maxActive, RevalScriptedSource.active);

    try {
      if (RevalScriptedSource.gate) {
        await RevalScriptedSource.gate;
      }
      return RevalScriptedSource.answers.length > 0 ? RevalScriptedSource.answers.shift()! : 'valid';
    } finally {
      RevalScriptedSource.active--;
    }
  }
}

/** Owns the tokens starting with 'revalhang-'; its revalidate() never settles. */
export class RevalHangingSource extends SocketPrincipalSource {
  public static calls = 0;

  public readonly name = 'reval-hanging';
  public readonly order = 4;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('revalhang-')) {
      return null;
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {} };
  }

  public revalidate(): Promise<SocketRevalidationResult> {
    RevalHangingSource.calls++;
    return new Promise(() => undefined);
  }
}

DI.register(RevalSource).as(SocketPrincipalSource);
DI.register(RevalHangingSource).as(SocketPrincipalSource);
DI.register(RevalThrowingSource).as(SocketPrincipalSource);
DI.register(RevalScriptedSource).as(SocketPrincipalSource);

@SocketController('reval')
export class RevalSocket extends BaseSocketController {
  @Command('ping')
  public async ping() {
    return 'pong';
  }

  @Command('attributes')
  public async attributes() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return { principal: store?.Principal.attributes ?? null, authn: store?.AuthnPrincipal?.attributes ?? null };
  }
}

function handshakeWith(token?: string): ISocketHandshake {
  return { auth: token ? { token } : {}, headers: {}, cookies: {}, address: '127.0.0.1', url: '/socket.io/', query: {}, secure: false, issuedAt: 0 };
}

describe('socket principal revalidation on commands', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;
  let clock: sinon.SinonFakeTimers | null = null;

  // the sweep is stopped: these tests drive the check of the command path alone
  const commandPathOnly = () => (DI.resolve(SocketPrincipalGuard) as SocketPrincipalGuard).stop();

  const start = async (revalidateMs: number, token?: string) => {
    t = await startServer({ http: { socket: { auth: { revalidateMs } } } });
    commandPathOnly();
    socket = await open(t, { auth: token ? { clientId: 'reval-client', token } : { clientId: 'reval-client' } });
  };

  afterEach(async () => {
    clock?.restore();
    clock = null;
    socket.close();
    await t.close();
  });

  it('SR-08 a credential revoked while the socket is open stops working after revalidateMs, and the socket is closed', async () => {
    await start(50, 'reval-a');
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    revalRevoked.add('reval-a');
    await delay(80);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);

    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials are no longer valid', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    await waitFor(() => !socket.connected);
  });

  it('refuses a principal whose ceiling expired without asking its source', async () => {
    await start(60_000, 'reval-expiring');
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    await delay(500);
    const before = revalChecks;

    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials expired', retryable: false });
    expect(revalChecks).to.equal(before);
  });

  it('revalidates once for concurrent commands and then waits revalidateMs again', async () => {
    await start(200, 'reval-b');
    await delay(250);
    const before = revalChecks;

    const replies = await Promise.all([1, 2, 3].map(() => command(socket, 'reval.ping')));
    expect(replies.every((r) => r.ok)).to.be.true;
    expect(revalChecks - before).to.equal(1);

    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
    expect(revalChecks - before).to.equal(1);
  });

  it('never revalidates with revalidateMs 0', async () => {
    await start(0, 'reval-c');
    revalRevoked.add('reval-c');
    await delay(30);

    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
  });

  it('leaves UNATTENDED connections alone', async () => {
    await start(10);
    await delay(30);

    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
  });

  it('re-checks after the default 60 s, not before', async () => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    // engine.io-client drops a connection whose ping is overdue by Date.now(), which the fake clock moves too
    t = await startServer({ http: { socket: { pingInterval: 300_000 } } });
    commandPathOnly();
    socket = await open(t, { auth: { clientId: 'reval-client', token: 'reval-d' } });

    revalRevoked.add('reval-d');
    clock.tick(59_000);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    clock.tick(1_000);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials are no longer valid', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('shows the principal a revalidation renewed to the command that triggered it', async () => {
    RevalScriptedSource.reset();
    await start(50, 'revalscript-renew');
    const renewed: Principal = { type: 'user', id: 'revalscript-renew', authenticated: true, source: 'token', attributes: { generation: 2 } };
    RevalScriptedSource.answers = [{ status: 'valid', principal: renewed }];
    await delay(80);

    expect(resultOf(await command(socket, 'reval.attributes'))).to.deep.equal({ principal: { generation: 2 }, authn: { generation: 2 } });
    expect(RevalScriptedSource.calls).to.equal(1);
  });

  it('closes a connection whose principal expired', async () => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await start(60_000, 'reval-expiring');

    clock.tick(400);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials expired', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    await waitFor(() => !socket.connected);
  });

  it('re-checks the expiry of a principal a valid answer has just renewed', async () => {
    RevalScriptedSource.reset();
    await start(50, 'revalscript-renew');
    await delay(80);
    RevalScriptedSource.answers = [{ status: 'valid', principal: { type: 'user', id: 'revalscript-renew', authenticated: true, source: 'token', attributes: {}, ceiling: { expiresAt: new Date(Date.now() - 1000) } } }];

    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials expired', retryable: false });
  });

  it('warns once when a grace window opens and once when it ends', async () => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await start(1_000, 'revalthrow-warn');
    const warn = sinon.stub((DI.resolve(SocketPrincipalGuard) as unknown as { Log: { warn: (...a: unknown[]) => void } }).Log, 'warn');

    try {
      clock.tick(1_000);
      expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
      expect(warn.callCount).to.equal(1);
      expect(warn.firstCall.args.some((a) => a instanceof Error)).to.be.true;

      clock.tick(1_000);
      expect(errorOf(await command(socket, 'reval.ping')).code).to.equal('unauthenticated');
      expect(warn.callCount).to.equal(2);
      expect(String(warn.secondCall.args.find((a) => typeof a === 'string'))).to.match(/closing after grace/);
    } finally {
      warn.restore();
    }
  });

  it('a source that cannot revalidate gets one grace interval, then the connection is refused', async () => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await start(1_000, 'revalthrow-a');
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    clock.tick(1_000);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    clock.tick(1_000);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials are no longer valid', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });
});

describe('socket principal revalidation sweep', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];
  let clock: sinon.SinonFakeTimers;

  /** Fakes Date and the sweep's interval before the server starts, so `clock.tick` runs sweep ticks. */
  const start = async (cfg: Record<string, unknown> = {}) => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date', 'setInterval', 'clearInterval'] });
    // engine.io-client drops a connection whose ping is overdue by Date.now(), which the fake clock moves too
    t = await startServer(_.merge({ http: { socket: { pingInterval: 300_000 } } }, cfg));
  };

  const openWith = async (token: string, clientId = 'reval-sweep-client'): Promise<ClientSocket> => {
    const socket = await open(t, { auth: { clientId, token } });
    sockets.push(socket);
    return socket;
  };

  const connectionOf = (socket: ClientSocket) => DI.resolve(SocketHub).connection(socket.id!)!;

  beforeEach(() => RevalScriptedSource.reset());

  afterEach(async () => {
    clock.restore();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('closes an idle socket whose credential was revoked once revalidateMs has passed, without any command', async () => {
    await start();
    const socket = await openWith('reval-idle');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect, 5000);
    const before = revalChecks;

    revalRevoked.add('reval-idle');
    clock.tick(59_000);
    await delay(30);
    expect(socket.connected).to.be.true;
    expect(revalChecks).to.equal(before);

    clock.tick(1_000);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect(revalChecks).to.equal(before + 1);
    await waitFor(() => !socket.connected);
  });

  it('closes an idle socket past ceiling.expiresAt within one tick, without asking its source', async () => {
    await start();
    const socket = await openWith('reval-expiring');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    const before = revalChecks;

    clock.tick(1_000);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect(revalChecks).to.equal(before);
    await waitFor(() => !socket.connected);
  });

  it('enforces expiry with revalidateMs 0', async () => {
    await start({ http: { socket: { auth: { revalidateMs: 0 } } } });
    const socket = await openWith('reval-expiring');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);

    clock.tick(1_000);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('keeps a socket whose source is unavailable once for one more interval, serving its commands, until a valid answer', async () => {
    RevalScriptedSource.answers = ['unavailable', 'valid'];
    await start();
    const socket = await openWith('revalscript-a');

    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === 1);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
    expect(RevalScriptedSource.calls).to.equal(1);

    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === 2);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
    expect(connectionOf(socket).auth.unavailableSince).to.be.undefined;

    // the grace window is over: a later 'unavailable' opens a new one instead of closing
    RevalScriptedSource.answers = ['unavailable'];
    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === 3);
    await delay(30);
    expect(socket.connected).to.be.true;
  });

  it('closes a socket whose source is unavailable twice in a row', async () => {
    RevalScriptedSource.answers = ['unavailable', 'unavailable'];
    await start();
    const socket = await openWith('revalscript-b');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect, 5000);

    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === 1);
    await delay(30);
    expect(socket.connected).to.be.true;

    clock.tick(59_000);
    await delay(30);
    expect(RevalScriptedSource.calls).to.equal(1);

    clock.tick(1_000);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect(RevalScriptedSource.calls).to.equal(2);
  });

  it('reads a boolean answer as valid or invalid', async () => {
    RevalScriptedSource.answers = [true, false];
    await start();
    const socket = await openWith('revalscript-c');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect, 5000);

    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === 1);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    clock.tick(60_000);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('adopts the principal a valid answer carries, so a rotated credential outlives the old expiresAt', async () => {
    await start();
    const t0 = Date.now();
    const socket = await openWith('revalscript-expiring');
    const renewed: Principal = { type: 'user', id: 'revalscript-expiring', authenticated: true, source: 'token', attributes: {}, ceiling: { expiresAt: new Date(t0 + 600_000) } };
    RevalScriptedSource.answers = [{ status: 'valid', principal: renewed }];

    clock.tick(60_000);
    await waitFor(() => connectionOf(socket).principal === renewed);

    clock.tick(40_000);
    await delay(30);
    expect(socket.connected).to.be.true;
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
  });

  it('refuses a valid answer that carries another principal', async () => {
    await start();
    const socket = await openWith('revalscript-d');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect, 5000);
    RevalScriptedSource.answers = [{ status: 'valid', principal: { type: 'user', id: 'someone-else', authenticated: true, source: 'token', attributes: {} } }];

    clock.tick(60_000);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it(`runs at most ${MAX_CONCURRENT_REVALIDATIONS} revalidations at once and checks the rest on later ticks`, async () => {
    let release!: () => void;
    RevalScriptedSource.gate = new Promise<void>((resolve) => (release = resolve));
    await start();

    const total = MAX_CONCURRENT_REVALIDATIONS + 4;
    for (let i = 0; i < total; i++) {
      await openWith(`revalscript-cap-${i}`, `reval-sweep-client-${i}`);
    }

    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === MAX_CONCURRENT_REVALIDATIONS);
    clock.tick(1_000);
    await delay(30);
    expect(RevalScriptedSource.calls).to.equal(MAX_CONCURRENT_REVALIDATIONS);

    release();
    await waitFor(() => RevalScriptedSource.active === 0);
    await delay(10);
    clock.tick(1_000);
    await waitFor(() => RevalScriptedSource.calls === total);
    expect(RevalScriptedSource.maxActive).to.equal(MAX_CONCURRENT_REVALIDATIONS);
    expect(sockets.every((s) => s.connected)).to.be.true;
  });

  it('shares one revalidate call between a command and the sweep', async () => {
    let release!: () => void;
    RevalScriptedSource.gate = new Promise<void>((resolve) => (release = resolve));
    await start();
    const socket = await openWith('revalscript-e');

    clock.tick(60_000);
    await waitFor(() => RevalScriptedSource.calls === 1);
    const reply = command(socket, 'reval.ping');
    await delay(50);
    release();

    expect(resultOf(await reply)).to.equal('pong');
    expect(RevalScriptedSource.calls).to.equal(1);
  });

  it('leaves UNATTENDED connections alone', async () => {
    await start();
    const socket = await openWith('');

    clock.tick(120_000);
    await delay(30);
    expect(socket.connected).to.be.true;
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
  });

  it('starts one interval with the server and clears it on dispose', async () => {
    // no connection state recovery: socket.io's adapter keeps an interval of its own
    await start({ http: { socket: { recovery: { maxDisconnectionMs: 0 } } } });
    await openWith('reval-dispose');
    expect(clock.countTimers()).to.equal(1);

    await t.server.dispose();
    expect(clock.countTimers()).to.equal(0);
  });
});

describe('socket principal revalidation timeout', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const openWith = async (token: string, clientId: string): Promise<ClientSocket> => {
    const socket = await open(t, { auth: { clientId, token } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(() => {
    RevalHangingSource.calls = 0;
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('reads a source that never answers as unavailable: a command is served in the grace window, then the socket is closed', async () => {
    t = await startServer({ http: { socket: { auth: { revalidateMs: 100 } } } });
    const socket = await openWith('revalhang-a', 'hang-client');
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect, 5000);

    await waitFor(() => RevalHangingSource.calls === 1);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect(RevalHangingSource.calls).to.equal(2);
  });

  it(`frees the ${MAX_CONCURRENT_REVALIDATIONS} slots after the timeout, so a revoked socket behind hung ones is still closed`, async () => {
    t = await startServer({ http: { socket: { auth: { revalidateMs: 100 } } } });
    for (let i = 0; i < MAX_CONCURRENT_REVALIDATIONS + 1; i++) {
      await openWith(`revalhang-cap-${i}`, `hang-client-${i}`);
    }

    const revoked = await openWith('reval-hang-victim', 'hang-victim');
    const notice = nextEvent(revoked, SYSTEM_EVENTS.disconnect, 5000);
    revalRevoked.add('reval-hang-victim');

    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('stop() resets the running counter, and a stale check does not corrupt it after a restart', async () => {
    t = await startServer({ http: { socket: { auth: { revalidateMs: 100 } } } });
    await openWith('revalhang-restart', 'hang-restart');
    await waitFor(() => RevalHangingSource.calls === 1);

    const guard = DI.resolve(SocketPrincipalGuard) as SocketPrincipalGuard & { running: number };
    expect(guard.running).to.equal(1);

    guard.stop();
    expect(guard.running).to.equal(0);
    guard.start(() => DI.resolve(SocketHub).Connections.values());

    await delay(250);
    expect(guard.running).to.be.at.least(0);
    expect(guard.running).to.be.at.most(1);
  });
});

describe('SocketPrincipalSource.revalidate default', () => {
  const source = new TestPrincipalSource();

  it('answers valid with the principal the handshake still authenticates as', async () => {
    expect(await source.revalidate(handshakeWith('good'), ALICE_PRINCIPAL)).to.deep.equal({ status: 'valid', principal: ALICE_PRINCIPAL });
  });

  it('answers invalid when the source refuses the credential', async () => {
    expect(await source.revalidate(handshakeWith('bad'), ALICE_PRINCIPAL)).to.equal('invalid');
  });

  it('answers invalid when the handshake no longer carries the credential', async () => {
    expect(await source.revalidate(handshakeWith(), ALICE_PRINCIPAL)).to.equal('invalid');
  });

  it('answers invalid when the handshake authenticates as another principal', async () => {
    expect(await source.revalidate(handshakeWith('good'), { ...ALICE_PRINCIPAL, id: '2' })).to.equal('invalid');
  });

  it('answers unavailable when the source fails for another reason', async () => {
    expect(await source.revalidate(handshakeWith('crash'), ALICE_PRINCIPAL)).to.equal('unavailable');
  });
});
