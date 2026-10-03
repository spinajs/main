import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { rejectionOf } from './support/commands.js';
import { makeConnection } from './support/connection.js';
import { endless, serveStream } from './support/stream-stub.js';
import { collect, onlineStreams, readUntilFailure, streamsOn } from './support/streams.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

describe('client stream lifecycle', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('rejects at once with unavailable while offline ( whenOffline fail, the default )', async () => {
    const streams = streamsOn(makeConnection(server));

    const error = await rejectionOf(streams.stream('n.list').next());
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is offline', retryable: true });
  });

  it('holds the request while offline with whenOffline wait, and sends it once online', async () => {
    serveStream(server, 'n.list', () => ['a']);
    const connection = makeConnection(server);
    const streams = streamsOn(connection);

    const all = collect(streams.stream<string>('n.list', null, { whenOffline: 'wait' }));
    await sleep(30);
    expect(server.requests).to.have.length(0);

    connection.connect();
    expect(await all).to.deep.equal(['a']);
  });

  it('rejects with unavailable when still offline at the timeout', async () => {
    const streams = streamsOn(makeConnection(server));

    const error = await rejectionOf(streams.stream('n.list', null, { whenOffline: 'wait', timeoutMs: 50 }).next());
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true });
  });

  it('times out with deadline_exceeded when no reply arrives, and cancels', async () => {
    server.handlers.set('n.silent', () => new Promise(() => undefined));
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.silent', null, { timeoutMs: 300 }).next());
    expect(error.toWire()).to.deep.equal({ code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true });
    await until(() => server.cancels.length === 1);
  });

  it('times out with deadline_exceeded when the next frame does not come within timeoutMs, and cancels', async () => {
    serveStream(server, 'n.stuck', async function* () {
      yield 'first';
      await new Promise(() => undefined);
    });
    const { streams } = await onlineStreams(server, 300);
    const items = streams.stream<string>('n.stuck');

    expect((await items.next()).value).to.equal('first');
    const error = await rejectionOf(items.next());
    expect(error.toWire()).to.deep.equal({ code: 'deadline_exceeded', message: 'no stream frame before the timeout', retryable: true });
    await until(() => server.cancels.length === 1);
    expect(streams.activeStreams).to.equal(0);
  });

  it('a slow consumer is not timed out: the timeout runs only while next() waits', async () => {
    serveStream(server, 'n.two', () => ['a', 'b']);
    const { streams } = await onlineStreams(server, 300);
    const items = streams.stream<string>('n.two');

    expect((await items.next()).value).to.equal('a');
    await sleep(900);
    expect((await items.next()).value).to.equal('b');
    expect((await items.next()).done).to.be.true;
  });

  it('aborting the signal rejects with cancelled, drops buffered items and cancels the stream', async () => {
    serveStream(server, 'n.endless', () => endless());
    const { streams } = await onlineStreams(server);
    const controller = new AbortController();
    const items = streams.stream<number>('n.endless', null, { signal: controller.signal, credits: 4 });

    expect((await items.next()).value).to.equal(0);
    await until(() => items.buffered === 3);
    controller.abort();
    expect(items.buffered).to.equal(0);

    const error = await rejectionOf(items.next());
    expect(error.toWire()).to.deep.equal({ code: 'cancelled', message: 'the stream was cancelled', retryable: false });
    await until(() => server.cancels.length === 1);
    expect(streams.activeStreams).to.equal(0);
  });

  it('rejects at once, sending nothing, when the signal is already aborted', async () => {
    const { streams } = await onlineStreams(server);
    const controller = new AbortController();
    controller.abort();

    const error = await rejectionOf(streams.stream('n.list', null, { signal: controller.signal }).next());
    expect(error.code).to.equal('cancelled');
    expect(server.requests).to.have.length(0);
  });

  it('delivers what arrived before a drop, then rejects with a retryable unavailable', async () => {
    serveStream(server, 'n.endless', () => endless());
    const { streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.endless', null, { credits: 4 });

    expect((await items.next()).value).to.equal(0);
    // chunks 1, 2 and 3 are buffered: one consumed item frees less than half the window
    await until(() => items.buffered === 3);
    server.killConnections();
    await until(() => streams.activeStreams === 0);

    const { items: rest, error } = await readUntilFailure(items);
    expect(rest).to.deep.equal([1, 2, 3]);
    expect((error as { toWire(): unknown }).toWire()).to.deep.equal({ code: 'unavailable', message: 'the connection dropped during the stream', retryable: true });
  });

  it('rejects a waiting next() when the client closes', async () => {
    serveStream(server, 'n.once', async function* () {
      yield 0;
      await new Promise(() => undefined);
    });
    const { connection, streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.once');

    expect((await items.next()).value).to.equal(0);
    const pending = items.next();
    connection.close();

    const error = await rejectionOf(pending);
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is closed', retryable: false });
  });

  it('rejects a new stream on a closed client', async () => {
    const { connection, streams } = await onlineStreams(server);
    connection.close();

    const error = await rejectionOf(streams.stream('n.list').next());
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is closed', retryable: false });
  });
});
