import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { SYSTEM_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { ITestServer, command, delay, errorOf, nextEvent, open, resultOf, startServer, waitFor } from './harness.js';

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

DI.register(RevalSource).as(SocketPrincipalSource);
DI.register(RevalThrowingSource).as(SocketPrincipalSource);

@SocketController('reval')
export class RevalSocket extends BaseSocketController {
  @Command('ping')
  public async ping() {
    return 'pong';
  }
}

describe('socket principal revalidation', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;
  let clock: sinon.SinonFakeTimers | null = null;

  const start = async (revalidateMs: number, token?: string) => {
    t = await startServer({ http: { socket: { auth: { revalidateMs } } } });
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
    socket = await open(t, { auth: { clientId: 'reval-client', token: 'reval-d' } });

    revalRevoked.add('reval-d');
    clock.tick(59_000);
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    clock.tick(1_000);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials are no longer valid', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
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

  it('fails closed when the source cannot revalidate', async () => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await start(1_000, 'revalthrow-a');
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    clock.tick(1_000);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials are no longer valid', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });
});
