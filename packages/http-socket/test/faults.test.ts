import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketHub } from '../src/hub.js';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { ITestServer, command, connect, connected, nextEvent, nextId, open, resultOf, startServer } from './harness.js';
import { ackFaults, killConnection, killConnections, restart } from './faults.js';

export const faultRuns: string[] = [];

@SocketController('fault')
export class FaultKitSocket extends BaseSocketController {
  @Command('touch')
  public async touch() {
    faultRuns.push('touch');
    return 'touched';
  }
}

const closed = (socket: ClientSocket) => new Promise<string>((resolve) => socket.once('disconnect', (reason) => resolve(reason)));

describe('server fault kit', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  beforeEach(async () => {
    faultRuns.length = 0;
    t = await startServer();
  });

  afterEach(async () => {
    ackFaults.reset();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  const connect_ = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  it('kills every engine connection as a network drop does', async () => {
    const a = await connect_('fault-a');
    const b = await connect_('fault-b');
    const drops = [closed(a), closed(b)];

    expect(killConnections(t)).to.equal(2);
    expect(await Promise.all(drops)).to.deep.equal(['transport close', 'transport close']);
  });

  it('kills one connection by id', async () => {
    const a = await connect_('fault-one');
    const drop = closed(a);

    expect(killConnection(t, a.id!)).to.be.true;
    expect(await drop).to.equal('transport close');
    expect(killConnection(t, 'no-such-id')).to.be.false;
  });

  it('drops the reply of a command whose handler ran', async () => {
    const a = await connect_('fault-drop');
    ackFaults.drop = 1;
    const drop = closed(a);

    await expect(a.timeout(300).emitWithAck(WIRE_EVENTS.command, { id: nextId(), name: 'fault.touch' })).to.be.rejected;
    await drop;
    expect(faultRuns).to.deep.equal(['touch']);
    expect(ackFaults.drop).to.equal(0);
  });

  it('delays replies', async () => {
    const a = await connect_('fault-delay');
    ackFaults.delayMs = 200;
    const started = Date.now();

    expect(resultOf(await command(a, 'fault.touch'))).to.equal('touched');
    expect(Date.now() - started).to.be.at.least(190);
  });

  it('recovers a killed connection with its stored session', async () => {
    const first = await connect_('fault-recover');
    const id = first.id!;
    const received = nextEvent(first, 'fault.ping');
    DI.resolve(SocketHub).connection(id)!.emit('fault.ping', {});
    await received;
    const { _pid: pid, _lastOffset: offset } = first as unknown as { _pid: string; _lastOffset: string };
    const drop = closed(first);

    killConnection(t, id);
    await drop;

    const second = connect(t, { auth: { clientId: 'fault-recover', pid, offset } });
    sockets.push(second);
    await connected(second);
    expect(t.server.Io!.of('/').sockets.get(second.id!)!.recovered).to.be.true;
    expect(second.id).to.equal(id);
  });

  it('restarts the server on the same port and disconnects the old clients', async () => {
    const { port } = t.host.Http.address() as AddressInfo;
    const old = await connect_('fault-old');
    const gone = closed(old);
    t = await restart(t);

    await gone;
    expect((t.host.Http.address() as AddressInfo).port).to.equal(port);
    const a = await connect_('fault-restart');
    expect(resultOf(await command(a, 'fault.touch'))).to.equal('touched');
  });

  it('keeps the previous config on restart and stays down for downMs', async () => {
    await t.close();
    t = await startServer({ http: { socket: { path: '/fault-path' } } });
    const path = t.path;
    const stoppedAt = Date.now();
    t = await restart(t, undefined, 200);

    expect(Date.now() - stoppedAt).to.be.at.least(190);
    expect(t.path).to.equal(path);
    expect(t.cfg).to.deep.equal({ http: { socket: { path: '/fault-path' } } });
  });
});
