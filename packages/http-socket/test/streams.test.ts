import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { Command, Payload, Signal, SocketController } from '../src/decorators.js';
import { ITestServer, command, delay, errorOf, open, startServer, waitFor } from './harness.js';
import { consumeAsClient, rawStream } from './stream-client.js';

export const strmLog = {
  produced: new Map<string, number>(),
  finallyRan: new Set<string>(),
  aborts: new Map<string, unknown>(),
  closed: new Set<string>(),
  /** settles the pending next() of strm.stuck */
  release: null as (() => void) | null,
  reset(): void {
    this.produced.clear();
    this.finallyRan.clear();
    this.aborts.clear();
    this.closed.clear();
    this.release = null;
  },
};

/** An async iterable that is not a generator: the object itself has no return(), only its iterator does. */
function plainIterable(key: string, next: () => Promise<IteratorResult<unknown>>): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next,
      return: async () => {
        strmLog.closed.add(key);
        return { done: true, value: undefined };
      },
    }),
  };
}

@SocketController('strm')
export class StrmSocket extends BaseSocketController {
  @Command('count')
  public async *count(@Payload() p: { key: string; n?: number }, @Signal() signal: AbortSignal) {
    signal.addEventListener('abort', () => strmLog.aborts.set(p.key, signal.reason), { once: true });
    try {
      for (let i = 0; i < (p.n ?? Number.POSITIVE_INFINITY); i++) {
        strmLog.produced.set(p.key, i + 1);
        yield i;
      }
    } finally {
      strmLog.finallyRan.add(p.key);
    }
  }

  @Command('broken')
  public async *broken() {
    yield 'first';
    throw new ResourceNotFound('the rest is gone');
  }

  @Command('store')
  public async *store() {
    const als = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;
    for (let i = 0; i < 2; i++) {
      await delay(5);
      yield als.getStore()?.requestId ?? null;
    }
  }

  @Command('binary')
  public async *binary() {
    yield new Uint8Array([1, 2, 3]);
    yield { part: new Uint8Array([4, 5]) };
  }

  @Command('bigint')
  public async *bigint() {
    yield 1n;
  }

  @Command('empty')
  public async *empty() {
    // ends without an item
  }

  @Command('void')
  public async *nothing() {
    yield undefined;
  }

  @Command('iterable')
  public iterable(@Payload() p: { key: string }) {
    return plainIterable(p.key, async () => ({ done: true, value: undefined }));
  }

  @Command('ordered-plain', { ordered: 'connection' })
  public orderedPlain(@Payload() p: { key: string }) {
    return plainIterable(p.key, async () => ({ done: true, value: undefined }));
  }

  @Command('late')
  public async late(@Payload() p: { key: string }) {
    // ignores its signal, so it returns its stream after the command was answered
    await delay(150);
    return plainIterable(p.key, async () => ({ done: true, value: undefined }));
  }

  @Command('stuck')
  public stuck() {
    // ignores its signal: next() settles only when the test releases it
    return plainIterable(
      'stuck',
      () =>
        new Promise((resolve) => {
          strmLog.release = () => resolve({ done: true, value: undefined });
        }),
    );
  }

  @Command('idle')
  public async *idle(@Signal() signal: AbortSignal) {
    // never yields, so every credit granted stays outstanding
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }
}

describe('stream replies', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    strmLog.reset();
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('acks a stream reply, then sends only as many chunks as the client granted', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'slow' }, 2);

    expect(await s.reply).to.deep.equal({ id: s.id, ok: true, stream: true });
    await waitFor(() => s.chunks.length === 2);
    await delay(100);

    expect(s.chunks).to.deep.equal([
      { id: s.id, seq: 0, data: 0 },
      { id: s.id, seq: 1, data: 1 },
    ]);
    // spec §7: the slow consumer has no more chunks in flight than its credit, and the generator was not asked for more
    expect(strmLog.produced.get('slow')).to.equal(2);
  });

  it('sends more chunks as credit arrives and ends with the chunk count', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'five', n: 5 }, 2);
    await waitFor(() => s.chunks.length === 2);

    // three for the remaining chunks, one to find the end
    s.grant(4);
    await s.finished;

    expect(s.chunks.map((c) => c.data)).to.deep.equal([0, 1, 2, 3, 4]);
    expect(s.end).to.deep.equal({ id: s.id, seq: 5 });
    await waitFor(() => strmLog.finallyRan.has('five'));
  });

  it('ends an empty stream at once and sends undefined items as null', async () => {
    const empty = rawStream(socket, 'strm.empty', null, 1);
    await empty.finished;
    expect(empty.end).to.deep.equal({ id: empty.id, seq: 0 });

    const nothing = rawStream(socket, 'strm.void', null, 2);
    await nothing.finished;
    expect(nothing.chunks).to.deep.equal([{ id: nothing.id, seq: 0, data: null }]);
    expect(nothing.end).to.deep.equal({ id: nothing.id, seq: 1 });
  });

  it('cancel runs the generator finally block and fires its signal with cancelled', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'cancel' }, 1);
    await waitFor(() => s.chunks.length === 1);

    s.cancel();
    await s.finished;

    expect(s.fail?.error.code).to.equal('cancelled');
    await waitFor(() => strmLog.finallyRan.has('cancel'));
    expect((strmLog.aborts.get('cancel') as SocketException).code).to.equal('cancelled');
  });

  it('a disconnect stops the stream with unavailable and runs the generator finally block', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'gone' }, 1);
    await waitFor(() => s.chunks.length === 1);

    socket.close();

    await waitFor(() => strmLog.finallyRan.has('gone'));
    expect((strmLog.aborts.get('gone') as SocketException).code).to.equal('unavailable');
  });

  it('sends the mapped error as a fail frame after the chunks before it', async () => {
    const s = rawStream(socket, 'strm.broken', null, 4);
    await s.finished;

    expect(s.chunks.map((c) => c.data)).to.deep.equal(['first']);
    expect(s.fail?.error).to.deep.include({ code: 'not_found', message: 'the rest is gone', retryable: false });
  });

  it('fails with internal when a chunk cannot be encoded', async () => {
    const s = rawStream(socket, 'strm.bigint', null, 1);
    await s.finished;

    expect(s.chunks).to.deep.equal([]);
    expect(s.fail?.error.code).to.equal('internal');
  });

  it('pulls every chunk inside the call store, after the ack', async () => {
    const s = rawStream(socket, 'strm.store', null, 4, { id: 'store-stream-1' });
    await s.finished;

    expect(s.chunks.map((c) => c.data)).to.deep.equal(['store-stream-1', 'store-stream-1']);
  });

  it('carries binary chunk parts as attachments', async () => {
    const s = rawStream(socket, 'strm.binary', null, 4);
    await s.finished;

    expect(Array.from(new Uint8Array(s.chunks[0].data as ArrayBuffer))).to.deep.equal([1, 2, 3]);
    expect(Array.from(new Uint8Array((s.chunks[1].data as { part: ArrayBuffer }).part))).to.deep.equal([4, 5]);
  });

  it('answers a stream command sent without credits with failed_precondition and never starts the generator', async () => {
    const error = errorOf(await command(socket, 'strm.count', { key: 'plain' }));

    expect(error.code).to.equal('failed_precondition');
    expect(error.message).to.match(/open it as a stream/);
    expect(strmLog.produced.has('plain')).to.be.false;
  });

  it('keeps an open stream id in flight until the stream ends', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'dup' }, 1, { id: 'dup-stream' });
    await s.reply;

    expect(errorOf(await command(socket, 'strm.count', { key: 'dup2' }, { id: 'dup-stream', credits: 1 }))).to.deep.equal({ code: 'invalid_argument', message: 'request id already in flight', retryable: false });

    s.cancel();
    await s.finished;
    await delay(20);

    const again = rawStream(socket, 'strm.count', { key: 'dup3', n: 1 }, 2, { id: 'dup-stream' });
    await again.finished;
    expect(again.end).to.deep.equal({ id: 'dup-stream', seq: 1 });
  });

  it('ignores credit for unknown ids and malformed credit frames', async () => {
    socket.emit(WIRE_EVENTS.credit, { id: 'nobody', credits: 5 });
    socket.emit(WIRE_EVENTS.credit, { id: 'x', credits: -1 });
    socket.emit(WIRE_EVENTS.credit, 'garbage');

    const s = rawStream(socket, 'strm.count', { key: 'after-garbage', n: 1 }, 2);
    await s.finished;
    expect(s.end).to.deep.equal({ id: s.id, seq: 1 });
  });

  it('closes a refused async iterable that is not a generator through its iterator', async () => {
    const error = errorOf(await command(socket, 'strm.iterable', { key: 'refused' }));

    expect(error.code).to.equal('failed_precondition');
    await waitFor(() => strmLog.closed.has('refused'));
  });

  it('refuses a stream from an ordered command the registry could not see as one, and closes it', async () => {
    const error = errorOf(await command(socket, 'strm.ordered-plain', { key: 'ordered' }, { credits: 1 }));

    expect(error.code).to.equal('failed_precondition');
    expect(error.message).to.match(/ordered/);
    await waitFor(() => strmLog.closed.has('ordered'));
  });

  it('closes a stream the handler returns after its command was already answered', async () => {
    const error = errorOf(await command(socket, 'strm.late', { key: 'late' }, { deadline: 30, credits: 1 }));

    expect(error.code).to.equal('deadline_exceeded');
    await waitFor(() => strmLog.closed.has('late'));
  });

  it('shutdown ( abortAll ) fails an open stream with unavailable and runs the generator finally block', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'shutdown' }, 1);
    await waitFor(() => s.chunks.length === 1);

    DI.get(SocketDispatcher)!.abortAll(new SocketException('unavailable', 'server shutting down'));
    await s.finished;

    expect(s.fail?.error).to.deep.include({ code: 'unavailable', retryable: true });
    await waitFor(() => strmLog.finallyRan.has('shutdown'));
    expect((strmLog.aborts.get('shutdown') as SocketException).code).to.equal('unavailable');
  });

  it('sends exactly one fail frame for a cancel, even a repeated one', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'once' }, 1);
    let fails = 0;
    socket.on(WIRE_EVENTS.fail, (frame: { id: string }) => {
      if (frame.id === s.id) {
        fails++;
      }
    });
    await waitFor(() => s.chunks.length === 1);

    s.cancel();
    s.cancel();
    s.grant(1);
    await s.finished;
    await waitFor(() => strmLog.finallyRan.has('once'));
    await delay(100);

    expect(fails).to.equal(1);
  });

  describe('a consumer that grants as it reads', () => {
    beforeEach(async () => {
      socket.close();
      await t.close();
      t = await startServer({ http: { socket: { streams: { maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 2000 } } } });
      socket = await open(t);
    });

    // 8 is the client's DEFAULT_STREAM_CREDITS; the end costs one credit, which the client's grants always cover
    for (const window of [1, 2, 3, 8]) {
      it(`reaches the end without a stall for any item count, window ${window}`, async () => {
        for (const n of [0, 1, window - 1, window, window + 1, 2 * window, 2 * window + 1]) {
          const s = consumeAsClient(socket, 'strm.count', { key: `w${window}-n${n}`, n }, window);
          await s.finished;

          expect(s.fail, `window ${window}, ${n} items`).to.be.null;
          expect(s.end, `window ${window}, ${n} items`).to.deep.equal({ id: s.id, seq: n });
          expect(s.overCredit).to.be.false;
        }
      });
    }
  });

  describe('limits', () => {
    beforeEach(async () => {
      socket.close();
      await t.close();
      t = await startServer({ http: { socket: { streams: { maxCredits: 4, maxPerConnection: 1, stallTimeoutMs: 2000 } } } });
      socket = await open(t);
    });

    it('refuses an initial credit above streams.maxCredits with invalid_argument, without starting the generator', async () => {
      const reply = await rawStream(socket, 'strm.count', { key: 'greedy' }, 5).reply;

      expect(errorOf(reply)).to.deep.include({ code: 'invalid_argument', details: { limit: 4 }, retryable: false });
      expect(strmLog.produced.has('greedy')).to.be.false;
    });

    it('fails a stream when a grant would leave more than maxCredits outstanding', async () => {
      const s = rawStream(socket, 'strm.count', { key: 'over' }, 4);
      await waitFor(() => s.chunks.length === 4);

      s.grant(5);
      await s.finished;

      expect(s.fail?.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
      await waitFor(() => strmLog.finallyRan.has('over'));
    });

    it('fails a stream when repeated small grants would leave more than maxCredits outstanding', async () => {
      const s = rawStream(socket, 'strm.idle', null, 1);
      await s.reply;

      s.grant(1);
      s.grant(1);
      s.grant(1);
      await delay(100);
      expect(s.fail).to.be.null;

      s.grant(1);
      await s.finished;
      expect(s.fail?.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
    });

    it('drops malformed credit frames for an open stream without changing its outstanding credit', async () => {
      const s = rawStream(socket, 'strm.idle', null, 1);
      await s.reply;

      for (const credits of [-3, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
        socket.emit(WIRE_EVENTS.credit, { id: s.id, credits });
      }
      s.grant(3);
      await delay(100);
      expect(s.fail).to.be.null;

      s.grant(1);
      await s.finished;
      expect(s.fail?.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
    });

    it('refuses a stream beyond streams.maxPerConnection with resource_exhausted, and frees the slot when one ends', async () => {
      const first = rawStream(socket, 'strm.count', { key: 'cap-1' }, 1);
      await first.reply;

      const second = await rawStream(socket, 'strm.count', { key: 'cap-2' }, 1).reply;
      expect(errorOf(second)).to.deep.include({ code: 'resource_exhausted', retryable: true, retryAfterMs: 100 });

      first.cancel();
      await first.finished;
      await delay(20);

      const third = rawStream(socket, 'strm.count', { key: 'cap-3', n: 1 }, 2);
      await third.finished;
      expect(third.end).to.deep.equal({ id: third.id, seq: 1 });
    });

    it('holds the stream slot until a source that ignores its signal settles', async () => {
      const s = rawStream(socket, 'strm.stuck', null, 1);
      await s.reply;
      await waitFor(() => strmLog.release !== null);

      s.cancel();
      await s.finished;
      expect(s.fail?.error.code).to.equal('cancelled');
      await waitFor(() => strmLog.closed.has('stuck'));
      await delay(50);

      expect(errorOf(await rawStream(socket, 'strm.count', { key: 'blocked' }, 1).reply)).to.deep.include({ code: 'resource_exhausted', retryAfterMs: 100 });
      expect(strmLog.produced.has('blocked')).to.be.false;

      strmLog.release!();
      await delay(50);

      const freed = rawStream(socket, 'strm.count', { key: 'freed', n: 1 }, 2);
      await freed.finished;
      expect(freed.end).to.deep.equal({ id: freed.id, seq: 1 });
    });
  });

  describe('stall', () => {
    beforeEach(async () => {
      socket.close();
      await t.close();
      t = await startServer({ http: { socket: { streams: { maxCredits: 4, maxPerConnection: 1, stallTimeoutMs: 300 } } } });
      socket = await open(t);
    });

    it('fails a stream that gets no credit for stallTimeoutMs with deadline_exceeded', async () => {
      const s = rawStream(socket, 'strm.count', { key: 'stalled' }, 1);
      await s.finished;

      expect(s.chunks).to.have.length(1);
      expect(s.fail?.error).to.deep.include({ code: 'deadline_exceeded', retryable: true });
      expect((strmLog.aborts.get('stalled') as SocketException).code).to.equal('deadline_exceeded');
    });
  });

  describe('transport backpressure', () => {
    interface IEngineConn {
      transport: { writable: boolean };
      flush(): void;
    }

    /** Holds every frame in engine.io's write buffer, like a client that stopped reading its socket. */
    const stopFlushing = (): IEngineConn => {
      const conn = [...t.server.Io!.of('/').sockets.values()][0].conn as unknown as IEngineConn;
      conn.transport.writable = false;
      return conn;
    };
    const resumeFlushing = (conn: IEngineConn) => {
      conn.transport.writable = true;
      conn.flush();
    };

    beforeEach(async () => {
      socket.close();
      await t.close();
      t = await startServer({ http: { socket: { streams: { maxCredits: 4, maxPerConnection: 1, stallTimeoutMs: 300 } } } });
      socket = await open(t);
    });

    it('stops pulling while the transport does not flush, however much credit the client grants blind, and resumes once it flushes', async () => {
      const conn = stopFlushing();
      const s = rawStream(socket, 'strm.count', { key: 'blind' }, 4);
      await waitFor(() => strmLog.produced.get('blind') === 4);

      s.grant(4);
      await delay(100);
      expect(strmLog.produced.get('blind')).to.equal(4);

      resumeFlushing(conn);
      await waitFor(() => s.chunks.length === 8);
      expect(strmLog.produced.get('blind')).to.equal(8);
      s.cancel();
      await s.finished;
    });

    it('fails a stream whose client never drains with deadline_exceeded and frees its slot', async () => {
      const conn = stopFlushing();
      const s = rawStream(socket, 'strm.count', { key: 'deaf' }, 4);
      await waitFor(() => strmLog.produced.get('deaf') === 4);
      s.grant(4);

      await waitFor(() => strmLog.finallyRan.has('deaf'));
      expect(strmLog.aborts.get('deaf')).to.deep.include({ code: 'deadline_exceeded' });
      expect(strmLog.produced.get('deaf')).to.equal(4);

      resumeFlushing(conn);
      await s.finished;
      expect(s.fail?.error.code).to.equal('deadline_exceeded');

      const next = rawStream(socket, 'strm.count', { key: 'after', n: 1 }, 2);
      await next.finished;
      expect(next.end).to.deep.equal({ id: next.id, seq: 1 });
    });
  });
});

