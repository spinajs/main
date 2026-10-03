import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { SOCKET_METRIC_KEY_STREAMS, socketMetrics } from '../src/metrics.js';
import { ITestServer, delay, open, startServer, waitFor } from './harness.js';
import { rawStream } from './stream-client.js';

@SocketController('strmobs')
export class StrmObsSocket extends BaseSocketController {
  @Command('two')
  public async *two() {
    yield 1;
    yield 2;
  }

  @Command('many')
  public async *many() {
    for (let i = 0; ; i++) {
      yield i;
    }
  }

  @Command('broken')
  public async *broken() {
    yield 1;
    throw new Error('boom');
  }
}

async function metricsText(): Promise<string> {
  return (DI.resolve(Metrics) as Metrics).render();
}

async function untilMetric(line: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await metricsText()).includes(line)) {
    if (Date.now() > deadline) {
      throw new Error(`metric line never appeared: ${line}`);
    }
    await delay(10);
  }
}

type DebugLog = { Log: { debug: (...args: unknown[]) => void } };

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
    await untilMetric('socket_streams_total{command="strmobs.two",code="cancelled"} 1');

    const text = await metricsText();
    expect(text).to.contain('socket_streams_total{command="strmobs.two",code="ok"} 1');
    // the stream reply itself is one ok command
    expect(text).to.contain('socket_commands_total{command="strmobs.two",code="ok"} 2');
  });

  it('writes one debug line per stream', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    const debug = sinon.spy((dispatcher as unknown as DebugLog).Log, 'debug');

    const s = rawStream(socket, 'strmobs.two', null, 4);
    await s.finished;
    const streamLines = () => debug.getCalls().map((c) => String(c.args[0])).filter((line) => /^socket stream /.test(line));
    await waitFor(() => streamLines().length > 0);

    expect(streamLines()).to.have.length(1);
    expect(streamLines()[0]).to.match(/^socket stream strmobs\.two ok 2 chunks \d+ms connection /);
  });

  it('still counts a stream whose debug line throws', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    sinon.stub((dispatcher as unknown as DebugLog).Log, 'debug').throws(new Error('log down'));

    const s = rawStream(socket, 'strmobs.two', null, 4);
    await s.finished;

    await untilMetric('socket_streams_total{command="strmobs.two",code="ok"} 1');
  });

  it('counts a throwing source as internal', async () => {
    const s = rawStream(socket, 'strmobs.broken', null, 4);
    await s.finished;

    await untilMetric('socket_streams_total{command="strmobs.broken",code="internal"} 1');
  });

  it('counts a disconnect as unavailable', async () => {
    const s = rawStream(socket, 'strmobs.many', null, 1);
    await waitFor(() => s.chunks.length === 1);
    socket.close();

    await untilMetric('socket_streams_total{command="strmobs.many",code="unavailable"} 1');
  });
});

describe('stream observability with tight limits', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer({ http: { socket: { streams: { maxCredits: 4, maxPerConnection: 1, stallTimeoutMs: 200 } } } });
    socket = await open(t);
  });

  afterEach(async () => {
    sinon.restore();
    socket.close();
    await t.close();
  });

  it('counts a stall as deadline_exceeded', async () => {
    const s = rawStream(socket, 'strmobs.many', null, 1);
    await s.finished;

    expect(s.fail?.error.code).to.equal('deadline_exceeded');
    await untilMetric('socket_streams_total{command="strmobs.many",code="deadline_exceeded"} 1');
  });

  it('counts a grant over the limit as invalid_argument', async () => {
    const s = rawStream(socket, 'strmobs.many', null, 1);
    await waitFor(() => s.chunks.length === 1);
    s.grant(5);
    await s.finished;

    await untilMetric('socket_streams_total{command="strmobs.many",code="invalid_argument"} 1');
  });

  async function expectReleasedAfterRun(): Promise<void> {
    const first = rawStream(socket, 'strmobs.two', null, 4, { id: 'reused-stream-id' });
    await first.finished;
    await delay(50);

    // same id again with maxPerConnection 1: only works when the first stream was fully released
    const second = rawStream(socket, 'strmobs.two', null, 4, { id: 'reused-stream-id' });
    await second.finished;
    expect((await second.reply).ok).to.equal(true);
    expect(second.end).to.not.equal(null);
  }

  it('releases the request id and the stream slot when logging throws', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    sinon.stub((dispatcher as unknown as DebugLog).Log, 'debug').throws(new Error('log down'));

    await expectReleasedAfterRun();
  });

  it('releases the request id and the stream slot when counting throws', async () => {
    const counter = socketMetrics()![SOCKET_METRIC_KEY_STREAMS] as unknown as { inc: (...args: unknown[]) => void };
    const inc = sinon.stub(counter, 'inc').throws(new Error('metrics down'));

    await expectReleasedAfterRun();
    expect(inc.called).to.equal(true);
  });
});
