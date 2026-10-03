import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Connection, OnConnect, OnDisconnect, SocketController } from '../src/decorators.js';
import { SocketHub } from '../src/hub.js';
import { ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { SocketConnection } from '../src/connection.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { IConnectOptions, ITestServer, connect, connected, delay, nextEvent, open, startServer, waitFor } from './harness.js';

export class RecoveredUser {
  constructor(public readonly name: string) {}

  public greet(): string {
    return `hi ${this.name}`;
  }
}

export const recoveryHooks: boolean[] = [];

@SocketController('recovery')
export class RecoveryHookSocket extends BaseSocketController {
  @OnConnect()
  public async seen(@Connection() conn: SocketConnection) {
    if (conn.clientId === 'recov-hooks') {
      recoveryHooks.push(conn.recovered);
    }
  }
}

export const recoveryOrder: string[] = [];

/** Released by a test; holds the disconnect hooks of the dropped 'recov-order' connection. */
export const recoveryGate = { open: () => {}, opened: Promise.resolve() };

@SocketController('recovery-order')
export class RecoveryOrderSocket extends BaseSocketController {
  @OnConnect()
  public async connected(@Connection() conn: SocketConnection) {
    if (conn.clientId === 'recov-order' || conn.clientId === 'recov-refused') {
      recoveryOrder.push(`connect ${conn.id} ${conn.recovered}`);
    }
  }

  @OnDisconnect()
  public async gone(@Connection() conn: SocketConnection) {
    if (conn.clientId === 'recov-order' && !conn.recovered) {
      await recoveryGate.opened;
    }
    if (conn.clientId === 'recov-order' || conn.clientId === 'recov-refused') {
      recoveryOrder.push(`disconnect ${conn.id} ${conn.recovered}`);
    }
  }
}

/** Owns the tokens starting with 'recov-'; 'recov-expiring' expires 300 ms after its handshake. */
export class RecoverySource extends SocketPrincipalSource {
  public readonly name = 'recovery';
  public readonly order = 4;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('recov-')) {
      return null;
    }

    return {
      type: 'user',
      id: token,
      authenticated: true,
      source: 'token',
      attributes: {},
      ...(token === 'recov-expiring' ? { ceiling: { expiresAt: new Date(Date.now() + 300) } } : {}),
      ...(token === 'recov-user' ? { identity: new RecoveredUser('ann') } : {}),
    };
  }
}

DI.register(RecoverySource).as(SocketPrincipalSource);

describe('socket connection state recovery and the principal', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  /** Opens a connection with one stored packet, drops its transport with `drop`, then pushes a packet it misses. */
  const dropped = async (options: IConnectOptions, drop: (id: string, first: ClientSocket) => void = (_id, first) => first.io.engine.close()) => {
    const hub = DI.resolve(SocketHub);
    const first = track(await open(t, options));
    const id = first.id!;

    const received = nextEvent(first, 'recovery.ping');
    hub.connection(id)!.emit('recovery.ping', {});
    await received;

    const { _pid: pid, _lastOffset: offset } = first as unknown as { _pid: string; _lastOffset: string };
    drop(id, first);
    await waitFor(() => hub.connection(id) === undefined);

    t.server.Io!.to(id).emit(WIRE_EVENTS.event, { name: 'recovery.missed', payload: {} });
    return { id, pid, offset };
  };

  // the client's own `recovered` compares against its previous pid, which a fresh client does not have
  const recovered = (socket: ClientSocket): boolean => t.server.Io!.of('/').sockets.get(socket.id!)!.recovered;

  /** Reconnects with the stored session; resolves whether the missed packet was replayed. */
  const reconnect = async (pid: string, offset: string, auth: Record<string, unknown> = {}) => {
    const second = track(connect(t, { auth: { pid, offset, ...auth } }));
    const missed = nextEvent(second, 'recovery.missed', 300).then(
      () => true,
      () => false,
    );
    await connected(second);
    return { second, replayed: await missed };
  };

  it('recovers a connection whose principal is still valid, with its missed packets', async () => {
    t = await startServer();
    const { id, pid, offset } = await dropped({ auth: { token: 'recov-ok' } });

    const { second, replayed } = await reconnect(pid, offset, { token: 'recov-ok' });

    expect(recovered(second)).to.be.true;
    expect(second.id).to.equal(id);
    expect(replayed).to.be.true;
  });

  it('forces a full handshake, without a replay, when the principal expired during the drop', async () => {
    t = await startServer();
    const { id, pid, offset } = await dropped({ auth: { token: 'recov-expiring' } });
    await delay(400);

    const { second, replayed } = await reconnect(pid, offset);

    expect(replayed).to.be.false;
    expect(recovered(second)).to.be.false;
    expect(second.id).not.to.equal(id);
    // the new handshake carries no token: it ran the sources again and got UNATTENDED
    expect(DI.resolve(SocketHub).connection(second.id!)!.authenticated).to.be.false;
  });

  it('keeps the check after io.adapter() replaces the adapter', async () => {
    t = await startServer();
    const io = t.server.Io!;
    io.adapter(io.adapter()!);
    const { id, pid, offset } = await dropped({ auth: { token: 'recov-expiring' } });
    await delay(400);

    const { second, replayed } = await reconnect(pid, offset);

    expect(replayed).to.be.false;
    expect(second.id).not.to.equal(id);
  });

  it('forces a full handshake when the principal fell due for revalidation during the drop', async () => {
    t = await startServer({ http: { socket: { auth: { revalidateMs: 200 } } } });
    const { id, pid, offset } = await dropped({ auth: { token: 'recov-ok' } });
    await delay(300);

    const { second, replayed } = await reconnect(pid, offset);

    expect(replayed).to.be.false;
    expect(recovered(second)).to.be.false;
    expect(second.id).not.to.equal(id);
  });

  it('does not restore the session of a connection the guard closed, even when its transport dropped before the close', async () => {
    t = await startServer();
    const guard = DI.resolve(SocketPrincipalGuard) as unknown as { close(connection: SocketConnection, why: string): void };

    const { id, pid, offset } = await dropped({ auth: { token: 'recov-ok' } }, (socketId) => {
      // the transport goes in the setImmediate gap between the guard's decision and its disconnect
      guard.close(DI.resolve(SocketHub).connection(socketId)!, 'test revocation');
      t.server.Io!.of('/').sockets.get(socketId)!.conn.close();
    });

    const { second, replayed } = await reconnect(pid, offset);

    expect(replayed).to.be.false;
    expect(recovered(second)).to.be.false;
    expect(second.id).not.to.equal(id);
  });

  it('tells the connect hooks whether the connection was recovered', async () => {
    t = await startServer();
    recoveryHooks.length = 0;
    const { pid, offset } = await dropped({ auth: { clientId: 'recov-hooks', token: 'recov-ok' } });

    const { second } = await reconnect(pid, offset, { clientId: 'recov-hooks', token: 'recov-ok' });
    await waitFor(() => recoveryHooks.length === 2);

    expect(recovered(second)).to.be.true;
    expect(recoveryHooks).to.deep.equal([false, true]);
  });

  it('re-checks the principal of a recovered connection and closes it when the source refuses it', async () => {
    t = await startServer();
    const { pid, offset } = await dropped({ auth: { token: 'recov-ok' } });

    // no token this time: the source no longer authenticates the connection
    const second = track(connect(t, { auth: { pid, offset } }));
    const kicked = nextEvent<{ reason: string }>(second, SYSTEM_EVENTS.disconnect);
    await connected(second);

    expect(await kicked).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('brings back the identity that a serializing adapter flattened', async () => {
    t = await startServer();
    const adapter = t.server.Io!.of('/').adapter as unknown as { restoreSession: (pid: string, offset: string) => Promise<{ data: unknown } | null> };
    const restore = adapter.restoreSession.bind(adapter);
    // what a Redis or Postgres adapter hands back: the session data as JSON
    adapter.restoreSession = async (pid, offset) => {
      const session = await restore(pid, offset);
      return session && { ...session, data: JSON.parse(JSON.stringify(session.data)) };
    };

    const { id, pid, offset } = await dropped({ auth: { token: 'recov-user' } });
    const { second } = await reconnect(pid, offset, { token: 'recov-user' });
    const hub = DI.resolve(SocketHub);

    expect(second.id).to.equal(id);
    await waitFor(() => hub.connection(id)?.user instanceof RecoveredUser);
    expect((hub.connection(id)!.user as RecoveredUser).greet()).to.equal('hi ann');
  });

  it('does not wait for the disconnect hooks of the dropped connection: they may finish after the connect hooks of the recovered one', async () => {
    t = await startServer();
    recoveryOrder.length = 0;
    recoveryGate.opened = new Promise<void>((resolve) => (recoveryGate.open = resolve));
    const { id, pid, offset } = await dropped({ auth: { clientId: 'recov-order', token: 'recov-ok' } });

    const { second } = await reconnect(pid, offset, { clientId: 'recov-order', token: 'recov-ok' });
    await waitFor(() => recoveryOrder.length === 2);
    recoveryGate.open();
    await waitFor(() => recoveryOrder.length === 3);

    expect(second.id).to.equal(id);
    expect(recoveryOrder).to.deep.equal([`connect ${id} false`, `connect ${id} true`, `disconnect ${id} false`]);
  });

  it('runs no disconnect hooks for a recovered connection the re-check refused, as it ran no connect hooks', async () => {
    t = await startServer();
    recoveryOrder.length = 0;
    const hub = DI.resolve(SocketHub);
    const { id, pid, offset } = await dropped({ auth: { clientId: 'recov-refused', token: 'recov-ok' } });
    await waitFor(() => recoveryOrder.length === 2);

    const second = track(connect(t, { auth: { pid, offset, clientId: 'recov-refused' } }));
    const kicked = nextEvent<{ reason: string }>(second, SYSTEM_EVENTS.disconnect);
    await connected(second);
    expect(await kicked).to.deep.equal({ reason: 'unauthenticated' });
    await waitFor(() => hub.connection(id) === undefined);
    await delay(100);

    expect(recoveryOrder).to.deep.equal([`connect ${id} false`, `disconnect ${id} false`]);
    expect(DI.resolve(SocketPrincipalGuard).ClosingIds.has(id)).to.be.false;
  });
});
