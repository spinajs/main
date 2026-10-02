import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SYSTEM_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, Payload, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { ALICE, ITestServer, command, nextEvent, open, resultOf, startServer } from './harness.js';

@SocketController('hub')
export class HubSocket extends BaseSocketController {
  @Command('join')
  public async join(@Payload() p: { room: string }, @Connection() conn: SocketConnection) {
    conn.join(p.room);
    return [...conn.rooms];
  }

  @Command('poke')
  public async poke(@Connection() conn: SocketConnection) {
    conn.emit('hub.poked', { by: 'server' });
    return true;
  }
}

describe('SocketHub', function () {
  this.timeout(15000);

  let t: ITestServer;
  let a: ClientSocket;
  let b: ClientSocket;
  let hub: SocketHub;

  beforeEach(async () => {
    t = await startServer();
    a = await open(t, { auth: { clientId: 'hub-a', token: 'good' } });
    b = await open(t, { auth: { clientId: 'hub-b' } });
    hub = DI.resolve(SocketHub);
  });

  afterEach(async () => {
    sinon.restore();
    a.close();
    b.close();
    await t.close();
  });

  it('pushes to a room only the connections that joined it', async () => {
    const rooms = resultOf(await command<string[]>(a, 'hub.join', { room: 'r1' }));
    expect(rooms).to.include('r1').and.not.include(a.id);

    const missed = nextEvent(b, 'hub.news', 300);
    const received = nextEvent(a, 'hub.news');
    hub.to('r1').emit('hub.news', { n: 1 });

    expect(await received).to.deep.equal({ n: 1 });
    await expect(missed).to.be.rejectedWith(/no hub.news event/);
  });

  it('pushes to one connection by id', async () => {
    const missed = nextEvent(a, 'hub.private', 300);
    const received = nextEvent(b, 'hub.private');
    hub.toConnection(b.id!).emit('hub.private', { to: 'b' });

    expect(await received).to.deep.equal({ to: 'b' });
    await expect(missed).to.be.rejectedWith(/no hub.private event/);
  });

  it('joins and leaves rooms by connection id and lists their members', async () => {
    hub.join(b.id!, 'r2');
    expect(await hub.connectionsIn('r2')).to.deep.equal([b.id]);
    expect([...hub.connection(b.id!)!.rooms]).to.include('r2');

    hub.leave(b.id!, 'r2');
    expect(await hub.connectionsIn('r2')).to.deep.equal([]);
  });

  it('lets a handler push to its own connection', async () => {
    const poked = nextEvent(a, 'hub.poked');
    expect(resultOf(await command(a, 'hub.poke'))).to.be.true;
    expect(await poked).to.deep.equal({ by: 'server' });
  });

  it('disconnects a connection and tells it why', async () => {
    const notice = nextEvent(a, SYSTEM_EVENTS.disconnect);
    const closed = new Promise<string>((resolve) => a.once('disconnect', (reason) => resolve(reason)));
    hub.disconnect(a.id!, 'kicked');

    expect(await notice).to.deep.equal({ reason: 'kicked' });
    expect(await closed).to.equal('io server disconnect');
  });

  it('finds local connections with their identity', () => {
    const connection = hub.connection(a.id!)!;
    expect(connection.clientId).to.equal('hub-a');
    expect(connection.user).to.deep.equal(ALICE);
    expect(hub.Connections.size).to.equal(2);
  });

  it('refuses to push before it is attached', () => {
    expect(() => new SocketHub().to('x')).to.throw(InvalidOperation, /not attached/);
  });

  it('refuses a pushed event name the wire protocol would reject', () => {
    for (const name of ['', 'has space', 'x'.repeat(129), 'bad/name']) {
      expect(() => hub.to('r1').emit(name, {}), name).to.throw(InvalidArgument, /Pushed event name/);
    }
  });

  it('does not push to a connection the principal guard is closing', async () => {
    const connection = hub.connection(a.id!)!;
    sinon.stub(connection, 'disconnect');
    const guard = DI.resolve(SocketPrincipalGuard);
    (guard as unknown as { close(c: SocketConnection, why: string): void }).close(connection, 'revoked');
    expect(guard.isClosing(connection)).to.be.true;

    hub.join(a.id!, 'r3');
    hub.join(b.id!, 'r3');
    const missedRoom = nextEvent(a, 'hub.room', 300);
    const missedDirect = nextEvent(a, 'hub.direct', 300);
    const delivered = nextEvent(b, 'hub.room');
    hub.to('r3').emit('hub.room', 1);
    hub.toConnection(a.id!).emit('hub.direct', 1);

    expect(await delivered).to.equal(1);
    await expect(missedRoom).to.be.rejectedWith(/no hub.room event/);
    await expect(missedDirect).to.be.rejectedWith(/no hub.direct event/);
  });
});
