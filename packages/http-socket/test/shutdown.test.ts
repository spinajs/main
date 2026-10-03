import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI, Injectable } from '@spinajs/di';
import { SYSTEM_EVENTS, ShutdownNotice, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnDisconnect, Payload, Signal, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { IdempotencyStore, MemoryIdempotencyStore } from '../src/idempotency.js';
import type { IdempotentReply } from '../src/interfaces.js';
import { assertShutdownConfig } from '../src/limits.js';
import { ITestServer, command, connect, delay, errorOf, nextEvent, open, refusalOf, resultOf, startServer } from './harness.js';
import { rawStream } from './stream-client.js';

export const shutAborts: string[] = [];
export const shutHooks: boolean[] = [];

/** Releases slowly, so a shutdown that closes before the release lands is visible. */
@Injectable(IdempotencyStore)
export class ShutSlowReleaseStore extends MemoryIdempotencyStore {
  public static last: ShutSlowReleaseStore | null = null;
  public released: string[] = [];
  public completed: string[] = [];

  constructor() {
    super();
    ShutSlowReleaseStore.last = this;
  }

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    this.completed.push(key);
    return super.complete(key, reply, ttlMs);
  }

  public async release(key: string): Promise<void> {
    await delay(100);
    await super.release(key);
    this.released.push(key);
  }
}

@SocketController('shut')
export class ShutdownSocket extends BaseSocketController {
  @Command('work')
  public async work(@Payload() p: { ms: number }) {
    await delay(p.ms);
    return 'done';
  }

  @Command('hang')
  public async hang(@Signal() signal: AbortSignal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    shutAborts.push((signal.reason as { code: string }).code);
    return 'late';
  }

  @Command('hangKeyed', { idempotent: true })
  public async hangKeyed(@Signal() signal: AbortSignal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw signal.reason;
  }

  @Command('ticks')
  public async *ticks(@Payload() p: { n: number; ms: number }) {
    for (let i = 0; i < p.n; i++) {
      await delay(p.ms);
      yield i;
    }
  }

  @Command('join')
  public async join(@Connection() conn: SocketConnection) {
    conn.join('shut-room');
    return true;
  }

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection) {
    if (conn.clientId !== 'shut-hooks') {
      return;
    }

    await delay(100);
    try {
      DI.resolve(SocketHub).to('shut-room').emit('shut.bye', {});
      shutHooks.push(true);
    } catch {
      shutHooks.push(false);
    }
  }
}

const CFG = { http: { socket: { drainMs: 2_000, shutdownRetryAfterMs: 700 } } };

describe('socket graceful shutdown', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connectAs = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    shutAborts.length = 0;
    shutHooks.length = 0;
    t = await startServer(CFG);
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('tells every connection when to come back, then lets a running command finish', async () => {
    const s = await connectAs('shut-finish');
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.work', { ms: 300 });
    await delay(50);

    const stopped = t.server.shutdown();

    expect(await notice).to.deep.equal({ retryAfterMs: 700 });
    expect(resultOf(await running)).to.equal('done');
    await stopped;
  });

  it('answers commands sent during the drain with unavailable and retryAfterMs', async () => {
    const s = await connectAs('shut-new');
    const notice = nextEvent(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.work', { ms: 300 });
    await delay(50);
    const stopped = t.server.shutdown();
    await notice;

    const error = errorOf(await command(s, 'shut.work', { ms: 0 }));

    expect(error).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
    await running;
    await stopped;
  });

  it('refuses new handshakes during the drain with unavailable and retryAfterMs', async () => {
    const s = await connectAs('shut-handshake');
    const running = command(s, 'shut.work', { ms: 300 });
    await delay(50);
    const stopped = t.server.shutdown();

    const late = connect(t, { auth: { clientId: 'shut-late' } });
    const refusal = await refusalOf(late);
    late.close();

    expect(refusal).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
    await running;
    await stopped;
  });

  it('answers a command still running after drainMs with unavailable instead of dropping the reply', async () => {
    await t.close();
    t = await startServer({ http: { socket: { drainMs: 200, shutdownRetryAfterMs: 700 } } });
    const s = await connectAs('shut-abort');
    const hanging = command(s, 'shut.hang');
    await delay(50);

    await t.server.shutdown();

    expect(errorOf(await hanging)).to.include({ code: 'unavailable', retryAfterMs: 700 });
    expect(shutAborts).to.deep.equal(['unavailable']);
  });

  it('releases the idempotency key of a command aborted at the drain deadline instead of storing unavailable', async () => {
    await t.close();
    t = await startServer({ http: { socket: { drainMs: 200, shutdownRetryAfterMs: 700, idempotency: { service: 'ShutSlowReleaseStore' } } } });
    const s = await connectAs('shut-keyed');
    const hanging = command(s, 'shut.hangKeyed', undefined, { idempotencyKey: 'shut-k1' });
    await delay(50);

    await t.server.shutdown();

    expect(errorOf(await hanging)).to.include({ code: 'unavailable', retryAfterMs: 700 });
    const store = ShutSlowReleaseStore.last!;
    // released before shutdown resolved, so a shared store lets the next instance run the retry
    expect(store.completed).to.deep.equal([]);
    expect(store.released).to.have.length(1);
    expect(await store.get(store.released[0])).to.be.null;
  });

  it('lets a stream that ends within drainMs finish before it closes', async () => {
    const s = await connectAs('shut-stream-end');
    const stream = rawStream(s, 'shut.ticks', { n: 4, ms: 100 }, 10);
    await stream.reply;
    const gone = new Promise<void>((resolve) => s.once('disconnect', () => resolve()));

    await t.server.shutdown();
    await Promise.race([stream.finished, gone]);

    expect(stream.fail).to.be.null;
    expect(stream.end).to.deep.equal({ id: stream.id, seq: 4 });
    expect(stream.chunks.map((c) => c.data)).to.deep.equal([0, 1, 2, 3]);
  });

  it('fails a stream still open after drainMs with unavailable and retryAfterMs, before the disconnect', async () => {
    await t.close();
    t = await startServer({ http: { socket: { drainMs: 200, shutdownRetryAfterMs: 700 } } });
    const s = await connectAs('shut-stream-open');
    const order: string[] = [];
    s.on(WIRE_EVENTS.fail, () => order.push('fail'));
    s.on('disconnect', () => order.push('disconnect'));
    const stream = rawStream(s, 'shut.ticks', { n: 1_000, ms: 50 }, 10);
    await stream.reply;

    await t.server.shutdown();
    await new Promise<void>((resolve) => (s.connected ? s.once('disconnect', () => resolve()) : resolve()));

    expect(order).to.deep.equal(['fail', 'disconnect']);
    expect(stream.fail!.error).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
  });

  it('waits for the disconnect hooks, which can still push, before it closes', async () => {
    const s = await connectAs('shut-hooks');
    await command(s, 'shut.join');

    await t.server.shutdown();

    expect(shutHooks).to.deep.equal([true]);
  });

  it('starts when the http server announces that it is closing', async () => {
    const s = await connectAs('shut-http');
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);

    DI.emit('http.server.closing');

    expect(await notice).to.deep.equal({ retryAfterMs: 700 });
  });

  it('is idempotent, and dispose waits for it', async () => {
    const first = t.server.shutdown();

    expect(t.server.shutdown()).to.equal(first);
    await Promise.all([first, t.server.dispose()]);
    expect(t.server.Io).to.be.null;
  });

  it('refuses a drainMs or shutdownRetryAfterMs it cannot use', () => {
    expect(() => assertShutdownConfig({ drainMs: 0, shutdownRetryAfterMs: 1 })).not.to.throw();

    for (const bad of [
      { drainMs: -1, shutdownRetryAfterMs: 1 },
      { drainMs: Number.NaN, shutdownRetryAfterMs: 1 },
      { drainMs: 2 ** 31, shutdownRetryAfterMs: 1 },
      { drainMs: 0, shutdownRetryAfterMs: 0 },
      { drainMs: 0, shutdownRetryAfterMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => assertShutdownConfig(bad), JSON.stringify(bad)).to.throw(RangeError);
    }
  });
});
