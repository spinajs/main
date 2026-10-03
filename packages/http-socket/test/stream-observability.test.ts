import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { ITestServer, delay, open, startServer, waitFor } from './harness.js';
import { rawStream } from './stream-client.js';

@SocketController('strmobs')
export class StrmObsSocket extends BaseSocketController {
  @Command('two')
  public async *two() {
    yield 1;
    yield 2;
  }
}

describe('stream observability', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    sinon.restore();
    socket.close();
    await t.close();
  });

  it('counts ended streams by command and outcome', async () => {
    const ok = rawStream(socket, 'strmobs.two', null, 4);
    await ok.finished;

    const cancelled = rawStream(socket, 'strmobs.two', null, 1);
    await waitFor(() => cancelled.chunks.length === 1);
    cancelled.cancel();
    await cancelled.finished;
    await delay(20);

    const text = await (DI.resolve(Metrics) as Metrics).render();
    expect(text).to.contain('socket_streams_total{command="strmobs.two",code="ok"} 1');
    expect(text).to.contain('socket_streams_total{command="strmobs.two",code="cancelled"} 1');
    // the stream reply itself is one ok command
    expect(text).to.contain('socket_commands_total{command="strmobs.two",code="ok"} 2');
  });

  it('writes one debug line per stream', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    const debug = sinon.spy((dispatcher as unknown as { Log: { debug: (...args: unknown[]) => void } }).Log, 'debug');

    const s = rawStream(socket, 'strmobs.two', null, 4);
    await s.finished;
    await delay(20);

    const lines = debug.getCalls().map((c) => String(c.args[0]));
    expect(lines.some((line) => /^socket stream strmobs\.two ok 2 chunks \d+ms connection /.test(line))).to.be.true;
  });
});
