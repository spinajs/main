import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { SocketException, WIRE_EVENTS, type CommandReply } from '@spinajs/http-socket-common';
import { closeAll } from './support/cleanup.js';
import { rejectionOf } from './support/commands.js';
import { endless, range, serveStream } from './support/stream-stub.js';
import { collect, onlineStreams, readUntilFailure } from './support/streams.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

chai.use(chaiAsPromised);

const streamReply = (id: string): CommandReply => ({ id, ok: true, stream: true });

describe('client stream replies', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('sends nothing before the first next(), then the request with the credit window, and yields every item in order', async () => {
    const logs = serveStream(server, 'n.list', () => [0, 1, 2, 3, 4]);
    const { streams } = await onlineStreams(server);

    const items = streams.stream<number>('n.list', { q: 'x' }, { traceparent: '00-abc-def-01' });
    await sleep(30);
    expect(server.requests).to.have.length(0);

    expect(await collect(items)).to.deep.equal([0, 1, 2, 3, 4]);

    const [request] = server.requests;
    expect(request).to.include({ name: 'n.list', credits: 8, traceparent: '00-abc-def-01' });
    expect(request.payload).to.deep.equal({ q: 'x' });
    expect(request.deadline).to.be.within(1, 1000);
    expect(logs[0].sent).to.equal(5);
  });

  it('never has more than `credits` chunks in flight or buffered ahead of a slow consumer ( spec §7 )', async () => {
    const logs = serveStream(server, 'n.many', () => range(20));
    const { streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.many', null, { credits: 4 });

    expect(await items.next()).to.deep.equal({ value: 0, done: false });
    await sleep(50);
    expect(logs[0].sent).to.equal(4);
    expect(logs[0].credits).to.deep.equal([]);

    expect(await items.next()).to.deep.equal({ value: 1, done: false });
    await sleep(50);
    // half the window is free: one grant of 2
    expect(logs[0].credits).to.deep.equal([2]);
    expect(logs[0].sent).to.equal(6);

    let consumed = 2;
    for await (const item of items) {
      expect(item).to.equal(consumed);
      consumed++;
      expect(logs[0].sent - consumed).to.be.at.most(4);
    }
    expect(consumed).to.equal(20);
  });

  it('break sends cancel for the stream, and the server source stops', async () => {
    const logs = serveStream(server, 'n.endless', () => endless());
    const { streams } = await onlineStreams(server);

    for await (const item of streams.stream<number>('n.endless', null, { credits: 2 })) {
      if (item === 2) break;
    }

    await until(() => logs[0].cancelled);
    expect(server.cancels).to.deep.equal([logs[0].request.id]);
  });

  it('delivers the chunks before a server failure, then rejects with its SocketError', async () => {
    serveStream(server, 'n.broken', async function* () {
      yield 1;
      yield 2;
      throw { code: 'not_found', message: 'gone', retryable: false };
    });
    const { streams } = await onlineStreams(server);

    const { items, error } = await readUntilFailure(streams.stream<number>('n.broken'));

    expect(items).to.deep.equal([1, 2]);
    expect(error).to.be.instanceOf(SocketException);
    expect((error as SocketException).toWire()).to.deep.equal({ code: 'not_found', message: 'gone', retryable: false });
  });

  it('rejects an error reply with its SocketError', async () => {
    server.handlers.set('n.denied', () => {
      throw { code: 'forbidden', message: 'no', retryable: false };
    });
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.denied').next());
    expect(error.toWire()).to.deep.equal({ code: 'forbidden', message: 'no', retryable: false });
  });

  it('rejects a plain result with failed_precondition', async () => {
    server.handlers.set('n.plain', () => 42);
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.plain').next());
    expect(error.toWire()).to.deep.equal({ code: 'failed_precondition', message: 'the command does not reply with a stream; use command()', retryable: false });
  });

  it('fails frames out of order with internal and cancels the stream', async () => {
    server.rawReplies.set('n.skip', (request, socket) => {
      setTimeout(() => socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq: 1, data: 'b' }), 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.skip').next());
    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'stream frames arrived out of order', retryable: false });
    await until(() => server.cancels.length === 1);
  });

  it('fails an end frame whose count differs from the chunks received', async () => {
    server.rawReplies.set('n.short', (request, socket) => {
      setTimeout(() => {
        socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq: 0, data: 'a' });
        socket.emit(WIRE_EVENTS.end, { id: request.id, seq: 2 });
      }, 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);
    const items = streams.stream<string>('n.short');

    expect((await items.next()).value).to.equal('a');
    const error = await rejectionOf(items.next());
    expect(error.message).to.equal('stream frames arrived out of order');
  });

  it('fails a chunk beyond the granted credit with internal', async () => {
    server.rawReplies.set('n.flood', (request, socket) => {
      setTimeout(() => {
        for (let seq = 0; seq < 6; seq++) socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq, data: seq });
      }, 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.flood', null, { credits: 4 });

    expect((await items.next()).value).to.equal(0);
    await sleep(50);
    const error = await rejectionOf(items.next());
    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'the server sent more chunks than it had credit for', retryable: false });
  });

  it('rejects a malformed reply with internal', async () => {
    server.rawReplies.set('n.garbage', () => 'not a reply');
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.garbage').next());
    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'malformed reply', retryable: false });
  });

  it('ignores frames of other ids', async () => {
    server.rawReplies.set('n.noise', (request, socket) => {
      setTimeout(() => {
        socket.emit(WIRE_EVENTS.chunk, { id: 'someone-else', seq: 0, data: 'x' });
        socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq: 0, data: 'mine' });
        socket.emit(WIRE_EVENTS.end, { id: request.id, seq: 1 });
      }, 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);

    expect(await collect(streams.stream('n.noise'))).to.deep.equal(['mine']);
  });

  it('streams binary chunk parts', async () => {
    serveStream(server, 'n.bin', () => [new Uint8Array([1, 2, 3])]);
    const { streams } = await onlineStreams(server);

    const [bytes] = await collect(streams.stream<ArrayBuffer>('n.bin'));
    expect(Array.from(new Uint8Array(bytes))).to.deep.equal([1, 2, 3]);
  });

  it('rejects credits that are not a positive integer with a RangeError, sending nothing', async () => {
    const { streams } = await onlineStreams(server);

    for (const credits of [0, -1, 1.5, Number.NaN]) {
      await expect(streams.stream('n.x', null, { credits }).next()).to.be.rejectedWith(RangeError);
    }
    expect(server.requests).to.have.length(0);
  });

  it('return() before the first next() sends nothing and ends the iterator', async () => {
    const { streams } = await onlineStreams(server);
    const items = streams.stream('n.x');

    expect(await items.return()).to.deep.equal({ value: undefined, done: true });
    expect(await items.next()).to.deep.equal({ value: undefined, done: true });
    await sleep(30);
    expect(server.requests).to.have.length(0);
  });
});
