import 'mocha';
import { expect } from 'chai';
import type { Socket } from 'node:net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { Adapter, BroadcastOptions } from 'socket.io-adapter';
import { DI, Injectable } from '@spinajs/di';
import { HttpServer, LifecycleState } from '@spinajs/http';
import { EventFrame, PROTOCOL_VERSION, SYSTEM_EVENTS, ShutdownNotice, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnDisconnect, OnEvent, Payload, Signal, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { IdempotencyRecord, IdempotencyStore, MemoryIdempotencyStore } from '../src/idempotency.js';
import type { IdempotentReply } from '../src/interfaces.js';
import { assertShutdownConfig, shutdownOverrun } from '../src/limits.js';
import { ITestServer, command, connect, connected, delay, errorOf, nextEvent, open, refusalOf, resultOf, startServer, waitFor } from './harness.js';
import { rawStream } from './stream-client.js';

export const shutAborts: string[] = [];
export const shutHooks: boolean[] = [];
export const shutRuns = new Map<string, number>();
export const shutEvents: string[] = [];

/** Never settles until a test opens it, so nothing outlives the suite. */
let shutGate: { promise: Promise<void>; open: () => void };
function newShutGate(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  shutGate = { promise, open };
}
newShutGate();

function run(tag: string): number {
  const n = (shutRuns.get(tag) ?? 0) + 1;
  shutRuns.set(tag, n);
  return n;
}

/** One store for every instance, as Redis or a database would be across a restart; it releases slowly, so a close before the release lands is visible. */
@Injectable(IdempotencyStore)
export class ShutSharedStore extends MemoryIdempotencyStore {
  public static readonly shared = new Map<string, unknown>();
  public static claimed: string[] = [];
  public static released: string[] = [];
  public static completed: string[] = [];

  public static reset(): void {
    ShutSharedStore.shared.clear();
    ShutSharedStore.claimed = [];
    ShutSharedStore.released = [];
    ShutSharedStore.completed = [];
  }

  constructor() {
    super();
    (this as unknown as { entries: Map<string, unknown> }).entries = ShutSharedStore.shared;
  }

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    const held = await super.claim(key);
    if (held === null) {
      ShutSharedStore.claimed.push(key);
    }
    return held;
  }

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    ShutSharedStore.completed.push(key);
    return super.complete(key, reply, ttlMs);
  }

  public async release(key: string): Promise<void> {
    await delay(100);
    await super.release(key);
    ShutSharedStore.released.push(key);
  }
}

/**
 * A cluster adapter: it applies a `local` disconnect at once, and anything else to every instance, here only later.
 * Its close never settles, as one waiting for an unreachable broker would.
 */
export class ShutClusterAdapter extends Adapter {
  public static remoteKicks = 0;

  public disconnectSockets(opts: BroadcastOptions, close: boolean): void {
    if (opts.flags?.local) {
      super.disconnectSockets(opts, close);
      return;
    }

    ShutClusterAdapter.remoteKicks++;
    setTimeout(() => super.disconnectSockets(opts, close), 50);
  }

  public close(): Promise<void> {
    return new Promise<void>(() => undefined);
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

  @Command('deaf')
  public async deaf() {
    await shutGate.promise;
    return 'late';
  }

  /** Throws the abort reason after it may have committed, so the server cannot tell its outcome apart from none. */
  @Command('hangKeyed', { idempotent: true })
  public async hangKeyed(@Payload() p: { tag: string }, @Signal() signal: AbortSignal) {
    run(p.tag);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw signal.reason;
  }

  @Command('slowKeyed', { idempotent: true })
  public async slowKeyed(@Payload() p: { tag: string; ms: number }) {
    const n = run(p.tag);
    await delay(p.ms);
    return { tag: p.tag, run: n };
  }

  @Command('orderedKeyed', { idempotent: true, ordered: 'client' })
  public async orderedKeyed(@Payload() p: { tag: string; ms: number }) {
    const n = run(p.tag);
    await delay(p.ms);
    return { tag: p.tag, run: n };
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

  @OnEvent('ping')
  public async ping(@Connection() conn: SocketConnection) {
    shutEvents.push(conn.clientId);
  }

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection) {
    if (conn.clientId === 'shut-hook-hang') {
      await shutGate.promise;
      return;
    }

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
const SHORT = { http: { socket: { drainMs: 200, shutdownRetryAfterMs: 700 } } };
const SHARED = { http: { socket: { drainMs: 200, shutdownRetryAfterMs: 700, idempotency: { service: 'ShutSharedStore' } } } };

describe('socket graceful shutdown', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connectAs = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  const restartWith = async (cfg: Record<string, unknown>) => {
    await t.close();
    t = await startServer(cfg);
  };

  const timed = async (work: Promise<unknown>) => {
    const started = Date.now();
    await work;
    return Date.now() - started;
  };

  beforeEach(async () => {
    shutAborts.length = 0;
    shutHooks.length = 0;
    shutEvents.length = 0;
    shutRuns.clear();
    ShutSharedStore.reset();
    ShutClusterAdapter.remoteKicks = 0;
    t = await startServer(CFG);
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
    shutGate.open();
    newShutGate();
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

  it('drops events sent during the drain', async () => {
    const s = await connectAs('shut-event');
    const notice = nextEvent(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.work', { ms: 400 });
    await delay(50);
    const stopped = t.server.shutdown();
    await notice;

    s.emit(WIRE_EVENTS.event, { name: 'shut.ping', payload: null });
    await running;
    await stopped;

    expect(shutEvents).to.deep.equal([]);
  });

  it('refuses new handshakes during the drain with unavailable and retryAfterMs', async () => {
    const s = await connectAs('shut-handshake');
    const running = command(s, 'shut.work', { ms: 1_500 });
    await delay(50);
    const stopped = t.server.shutdown();

    const late = connect(t, { auth: { clientId: 'shut-late' } });
    const refusal = await refusalOf(late);
    late.close();

    expect(refusal).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
    await running;
    await stopped;
  });

  it('tells a connection recovered during the drain when to come back before it refuses it', async () => {
    const hub = DI.resolve(SocketHub);
    const first = await connectAs('shut-recover');
    const id = first.id!;
    const stored = nextEvent(first, 'shut.stored');
    hub.connection(id)!.emit('shut.stored', {});
    await stored;
    const { _pid: pid, _lastOffset: offset } = first as unknown as { _pid: string; _lastOffset: string };
    first.io.engine.close();
    await waitFor(() => hub.connection(id) === undefined);

    const s = await connectAs('shut-busy');
    const running = command(s, 'shut.work', { ms: 1_500 });
    await delay(50);
    const stopped = t.server.shutdown();

    const second = connect(t, { auth: { clientId: 'shut-recover', pid, offset } });
    sockets.push(second);
    const frames: EventFrame[] = [];
    second.on(WIRE_EVENTS.event, (frame: EventFrame) => frames.push(frame));
    const gone = new Promise<void>((resolve) => second.once('disconnect', () => resolve()));
    await connected(second);
    await gone;

    expect(frames.map((f) => f.name)).to.deep.equal([SYSTEM_EVENTS.shutdown, SYSTEM_EVENTS.disconnect]);
    expect(frames[0].payload).to.deep.equal({ retryAfterMs: 700 });
    await running;
    await stopped;
  });

  it('answers a command still running after drainMs with unavailable instead of dropping the reply', async () => {
    await restartWith(SHORT);
    const s = await connectAs('shut-abort');
    const hanging = command(s, 'shut.hang');
    await delay(50);

    await t.server.shutdown();

    expect(errorOf(await hanging)).to.include({ code: 'unavailable', retryAfterMs: 700 });
    expect(shutAborts).to.deep.equal(['unavailable']);
  });

  it('closes within a bound when a handler ignores its abort signal', async () => {
    await restartWith(SHORT);
    const s = await connectAs('shut-deaf');
    const hanging = command(s, 'shut.deaf');
    await delay(50);

    const ms = await timed(t.server.shutdown());

    expect(errorOf(await hanging)).to.include({ code: 'unavailable', retryAfterMs: 700 });
    expect(ms).to.be.below(4_000);
  });

  it('answers a keyed command that finishes just after drainMs with its real reply, which a resend then replays', async () => {
    await restartWith(SHARED);
    const s = await connectAs('shut-keyed-late');
    const late = command(s, 'shut.slowKeyed', { tag: 'late', ms: 600 }, { idempotencyKey: 'shut-k-late' });
    await delay(50);

    await t.server.shutdown();

    expect(resultOf(await late)).to.deep.equal({ tag: 'late', run: 1 });
    expect(ShutSharedStore.completed).to.have.length(1);

    await restartWith(SHARED);
    const again = await connectAs('shut-keyed-late');
    const replayed = await command(again, 'shut.slowKeyed', { tag: 'late', ms: 600 }, { idempotencyKey: 'shut-k-late' });

    expect(resultOf(replayed)).to.deep.equal({ tag: 'late', run: 1 });
    expect(shutRuns.get('late')).to.equal(1);
  });

  it('keeps the key of a keyed handler still running after the grace claimed, even when it throws the abort reason', async () => {
    await restartWith(SHARED);
    const s = await connectAs('shut-keyed');
    const hanging = command(s, 'shut.hangKeyed', { tag: 'hung' }, { idempotencyKey: 'shut-k1' });
    await delay(50);

    await t.server.shutdown();

    expect(errorOf(await hanging)).to.include({ code: 'unavailable', retryAfterMs: 700 });
    await delay(200);
    expect(ShutSharedStore.claimed).to.have.length(1);
    expect(ShutSharedStore.completed).to.deep.equal([]);
    expect(ShutSharedStore.released).to.deep.equal([]);

    // the next instance must not run it a second time
    await restartWith(SHARED);
    const again = await connectAs('shut-keyed');
    const retried = errorOf(await command(again, 'shut.hangKeyed', { tag: 'hung' }, { idempotencyKey: 'shut-k1' }));

    expect(retried).to.include({ code: 'unavailable', retryable: true });
    expect(shutRuns.get('hung')).to.equal(1);
  });

  it('lets the running ordered keyed command finish at the deadline and releases the queued one, which never ran', async () => {
    await restartWith(SHARED);
    const s = await connectAs('shut-ordered');
    const first = command(s, 'shut.orderedKeyed', { tag: 'first', ms: 600 }, { idempotencyKey: 'shut-o1' });
    const second = command(s, 'shut.orderedKeyed', { tag: 'second', ms: 0 }, { idempotencyKey: 'shut-o2' });
    await delay(50);

    await t.server.shutdown();

    expect(resultOf(await first)).to.deep.equal({ tag: 'first', run: 1 });
    expect(errorOf(await second)).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
    expect(shutRuns.get('second')).to.equal(undefined);
    expect(ShutSharedStore.completed).to.have.length(1);
    expect(ShutSharedStore.released).to.have.length(1);
    expect(ShutSharedStore.shared.size).to.equal(1);
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
    await restartWith(SHORT);
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

  it('closes within a bound when a disconnect hook never finishes', async () => {
    await restartWith({ http: { socket: { drainMs: 300, shutdownRetryAfterMs: 700 } } });
    await connectAs('shut-hook-hang');

    const ms = await timed(t.server.shutdown());

    expect(ms).to.be.below(3_000);
  });

  it('disconnects only its own clients with a cluster adapter, awaits their hooks, and does not wait for an adapter that never closes', async () => {
    await restartWith({ http: { socket: { drainMs: 2_000, shutdownRetryAfterMs: 700, recovery: { maxDisconnectionMs: 0 } } } });
    t.server.Io!.adapter(ShutClusterAdapter);
    const s = await connectAs('shut-hooks');
    await command(s, 'shut.join');

    const ms = await timed(t.server.shutdown());

    expect(ShutClusterAdapter.remoteKicks).to.equal(0);
    expect(shutHooks).to.deep.equal([true]);
    expect(ms).to.be.below(4_000);
    expect(t.server.Io).to.be.null;
  });

  /** HttpServer's own stop() over the harness's http server, tracking connections as it does; resolving HttpServer would need its whole configuration. */
  const httpServerOver = (): HttpServer => {
    const http = Object.assign(new HttpServer(), { _httpServer: t.host.Http, _state: LifecycleState.Listening, Container: DI.RootContainer });
    const tracked = (http as unknown as { _connections: Set<Socket> })._connections;
    t.host.Http.on('connection', (socket: Socket) => {
      tracked.add(socket);
      socket.on('close', () => tracked.delete(socket));
    });
    return http;
  };

  it('drains a websocket client when HttpServer.stop() closes the http server', async () => {
    await restartWith({ http: { shutdownTimeout: 8_000, socket: { drainMs: 2_000, shutdownRetryAfterMs: 700 } } });
    const http = httpServerOver();
    const s = await connectAs('shut-http-ws');
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.work', { ms: 500 });
    await delay(50);

    const stopped = http.stop();

    expect(await notice).to.deep.equal({ retryAfterMs: 700 });
    expect(resultOf(await running)).to.equal('done');
    await stopped;
    await t.server.shutdown();
  });

  it('tells a polling client when to come back when HttpServer.stop() closes the http server, and keeps the outcome of its keyed command for the resend', async () => {
    await restartWith({ http: { shutdownTimeout: 8_000, socket: { drainMs: 2_000, shutdownRetryAfterMs: 700, idempotency: { service: 'ShutSharedStore' } } } });
    const http = httpServerOver();
    const auth = { protocol: PROTOCOL_VERSION, clientId: 'shut-polling' };
    const s = ioClient(t.url, { path: t.path, transports: ['polling'], reconnection: false, forceNew: true, auth });
    sockets.push(s);
    await connected(s);
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.slowKeyed', { tag: 'polled', ms: 500 }, { idempotencyKey: 'shut-p1' }).catch((err: Error) => err);
    await delay(50);

    await http.stop();

    // the listener is closed, so the next poll cannot reach this instance: the notice is all a polling client gets
    expect(await notice).to.deep.equal({ retryAfterMs: 700 });
    expect(await running).to.be.instanceOf(Error);
    await t.server.shutdown();
    expect(ShutSharedStore.completed).to.have.length(1);

    await restartWith({ http: { socket: { idempotency: { service: 'ShutSharedStore' } } } });
    const again = ioClient(t.url, { path: t.path, transports: ['polling'], reconnection: false, forceNew: true, auth });
    sockets.push(again);
    await connected(again);
    const replayed = await command(again, 'shut.slowKeyed', { tag: 'polled', ms: 500 }, { idempotencyKey: 'shut-p1' });

    expect(resultOf(replayed)).to.deep.equal({ tag: 'polled', run: 1 });
    expect(shutRuns.get('polled')).to.equal(1);
  });

  it('starts when its own http server announces that it is closing, not another one', async () => {
    const s = await connectAs('shut-http');
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown, 300);

    DI.emit('http.server.closing', { Server: {} });
    await notice.then(
      () => expect.fail('another http server closing must not shut this one down'),
      () => undefined,
    );

    const ours = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);
    DI.emit('http.server.closing', { Server: t.host.Http });

    expect(await ours).to.deep.equal({ retryAfterMs: 700 });
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

  it('warns when the http server would cut the drain short', () => {
    expect(shutdownOverrun(5_000, 10_000)).to.be.null;
    expect(shutdownOverrun(8_000, 10_000)).to.match(/http\.shutdownTimeout/);
  });
});
