import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { ITestServer, command, open, resultOf, startServer } from './harness.js';
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

  const connect = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  it('kills every engine connection as a network drop does', async () => {
    const a = await connect('fault-a');
    const b = await connect('fault-b');
    const drops = [closed(a), closed(b)];

    expect(killConnections(t)).to.equal(2);
    expect(await Promise.all(drops)).to.deep.equal(['transport close', 'transport close']);
  });

  it('kills one connection by id', async () => {
    const a = await connect('fault-one');
    const drop = closed(a);

    expect(killConnection(t, a.id!)).to.be.true;
    expect(await drop).to.equal('transport close');
    expect(killConnection(t, 'no-such-id')).to.be.false;
  });

  it('drops the reply of a command whose handler ran', async () => {
    const a = await connect('fault-drop');
    ackFaults.drop = 1;
    const drop = closed(a);

    await expect(command(a, 'fault.touch')).to.be.rejected;
    await drop;
    expect(faultRuns).to.deep.equal(['touch']);
    expect(ackFaults.drop).to.equal(0);
  });

  it('delays replies', async () => {
    const a = await connect('fault-delay');
    ackFaults.delayMs = 200;
    const started = Date.now();

    expect(resultOf(await command(a, 'fault.touch'))).to.equal('touched');
    expect(Date.now() - started).to.be.at.least(190);
  });

  it('restarts the server on the same port', async () => {
    const { port } = t.host.Http.address() as AddressInfo;
    t = await restart(t);

    expect((t.host.Http.address() as AddressInfo).port).to.equal(port);
    const a = await connect('fault-restart');
    expect(resultOf(await command(a, 'fault.touch'))).to.equal('touched');
  });
});
