import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { SocketHub } from '../src/hub.js';
import { ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { SocketConnection } from '../src/connection.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { IConnectOptions, ITestServer, connect, connected, delay, nextEvent, open, startServer, waitFor } from './harness.js';

/** Owns the tokens starting with 'recov-'; 'recov-expiring' expires 300 ms after its handshake. */
export class RecoverySource extends SocketPrincipalSource {
  public readonly name = 'recovery';
  public readonly order = 4;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('recov-')) {
      return null;
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {}, ...(token === 'recov-expiring' ? { ceiling: { expiresAt: new Date(Date.now() + 300) } } : {}) };
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
  const reconnect = async (pid: string, offset: string) => {
    const second = track(connect(t, { auth: { pid, offset } }));
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

    const { second, replayed } = await reconnect(pid, offset);

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
});
