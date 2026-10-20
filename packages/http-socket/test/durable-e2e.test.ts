import 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { DI, Injectable } from '@spinajs/di';
import { SocketClient, type SocketClientOptions } from '@spinajs/http-socket-client';
import { FileOutboxStore } from '@spinajs/http-socket-client/node';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, Payload, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { IdempotencyRecord, IdempotencyStore, MemoryIdempotencyStore } from '../src/idempotency.js';
import { ISocketCommandContext, IdempotentReply, STAGE_ORDER, SocketCommandStage } from '../src/interfaces.js';
import { ITestServer, delay, startServer, waitFor } from './harness.js';
import { ackFaults, killConnections } from './faults.js';

const envInt = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const COMMANDS = envInt('E2E_COMMANDS', 1000);
const KILLS = envInt('E2E_KILLS', 100);
const SEED = envInt('E2E_SEED', 0x5eed);

export const e2eRuns = new Map<number, number>();
export const e2eOrder: number[] = [];
export const e2eHooks: boolean[] = [];

/** Test-driven knobs and probes of the e2e controller and stages; reset before every test. */
export const e2eProbe = {
  /** a command with `gate` waits for it, so the kill schedule always ends before the queue does */
  gate: Promise.resolve() as Promise<void>,
  onRun: undefined as (() => void) | undefined,
  waiters: [] as Array<{ runs: number; resolve: () => void }>,
  /** keyed requests seen, fence refusals by predecessor key, and other refusals by code */
  requests: 0,
  fenced: [] as string[],
  refused: new Map<string, number>(),
  /** the jitter stage delays the commands of this clientId */
  jitterClientId: '',
  jitter: (() => 0) as () => number,
  jittered: 0,
  reset(): void {
    this.gate = Promise.resolve();
    this.onRun = undefined;
    this.waiters = [];
    this.requests = 0;
    this.fenced = [];
    this.refused = new Map();
    this.jitterClientId = '';
    this.jitter = () => 0;
    this.jittered = 0;
  },
};

const runsReach = (runs: number) => (e2eRuns.size >= runs ? Promise.resolve() : new Promise<void>((resolve) => e2eProbe.waiters.push({ runs, resolve })));

@SocketController('e2e')
export class DurableE2eSocket extends BaseSocketController {
  @Command('apply', { idempotent: true, ordered: 'client' })
  public async apply(@Payload() p: { n: number; ms: number; gate?: boolean }) {
    if (p.gate) {
      await e2eProbe.gate;
    }
    await delay(p.ms);
    e2eRuns.set(p.n, (e2eRuns.get(p.n) ?? 0) + 1);
    e2eOrder.push(p.n);
    e2eProbe.onRun?.();
    e2eProbe.waiters = e2eProbe.waiters.filter((waiter) => (e2eRuns.size >= waiter.runs ? (waiter.resolve(), false) : true));
    return p.n;
  }

  /** idempotent but not ordered: the `after` fence alone keeps a durable queue in order */
  @Command('loose', { idempotent: true })
  public async loose(@Payload() p: { n: number; ms: number }) {
    return this.apply(p);
  }

  @Command('slow')
  public async slow(@Payload() p: { ms: number }) {
    await delay(p.ms);
    return 'slow done';
  }

  @Command('ping')
  public async ping() {
    return 'pong';
  }

  @Command('join')
  public async join(@Connection() conn: SocketConnection) {
    conn.join('e2e-room');
    return true;
  }

  @OnConnect()
  public async seen(@Connection() conn: SocketConnection) {
    if (conn.clientId === 'e2e-rooms') {
      e2eHooks.push(conn.recovered);
    }
  }
}

/** Just inside the fault kit: sees every request of the e2e clients and how it was answered. */
@Injectable(SocketCommandStage)
export class DurableE2eObserverStage extends SocketCommandStage {
  public get Order(): number {
    return 20;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    if (!ctx.connection.clientId.startsWith('e2e-') || ctx.request.idempotencyKey === undefined) {
      return next();
    }

    e2eProbe.requests++;
    try {
      return await next();
    } catch (err) {
      const error = err as { code?: string; details?: { after?: unknown } };
      if (typeof error.details?.after === 'string') {
        e2eProbe.fenced.push(error.details.after);
      } else {
        // an aborted call's answer never reaches the client: its connection is gone
        const kind = ctx.signal.aborted ? 'aborted' : String(error.code);
        e2eProbe.refused.set(kind, (e2eProbe.refused.get(kind) ?? 0) + 1);
      }
      throw err;
    }
  }
}

/**
 * Idempotency latency between the claim and the ordering fence, seeded: a successor sent in the same
 * window can reach the fence before its predecessor does.
 */
@Injectable(SocketCommandStage)
export class DurableE2eJitterStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Idempotency + 20;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    if (e2eProbe.jitterClientId === '' || ctx.connection.clientId !== e2eProbe.jitterClientId) {
      return next();
    }

    const ms = Math.floor(e2eProbe.jitter() * 15);
    if (ms > 0) {
      e2eProbe.jittered++;
      await delay(ms);
    }
    return next();
  }
}

/** Loses some completed keys: one store write in ten fails, another one in ten is evicted at once ( as a TTL or the LRU cap would ). */
@Injectable(IdempotencyStore)
export class DurableE2eForgetfulStore extends MemoryIdempotencyStore {
  public static last: DurableE2eForgetfulStore | null = null;
  /** the raw idempotency keys whose completion was lost */
  public forgotten: string[] = [];
  public completions = 0;

  constructor() {
    super();
    DurableE2eForgetfulStore.last = this;
  }

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    const n = this.completions++;
    const raw = decodeURIComponent(key.slice(key.lastIndexOf(':') + 1));

    if (n % 10 === 3) {
      this.forgotten.push(raw);
      throw new Error('idempotency store unreachable');
    }

    await super.complete(key, reply, ttlMs);
    if (n % 10 === 7) {
      this.forgotten.push(raw);
      this.drop(key);
    }
  }
}

/**
 * Counts the claims answered with a completed reply: the resends the server replayed instead of running.
 * Not `get`: the ordering fence reads completed keys too, and those reads replay nothing.
 */
@Injectable(IdempotencyStore)
export class DurableE2eReplayStore extends MemoryIdempotencyStore {
  public static last: DurableE2eReplayStore | null = null;
  public replays = 0;

  constructor() {
    super();
    DurableE2eReplayStore.last = this;
  }

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    const held = await super.claim(key);
    if (held?.state === 'done') {
      this.replays++;
    }
    return held;
  }
}

/** Seeded, so a failing run can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (count: number) => Array.from({ length: count }, (_, n) => n);

/** Every command ran once, in send order, and every caller got its own result in send order. */
function expectExactlyOnceInOrder(count: number, resolved: number[]): void {
  expect(resolved, `client settlement order, seed ${SEED}`).to.deep.equal(range(count));
  expect(e2eOrder, `server run order, seed ${SEED}`).to.deep.equal(range(count));
  expect(
    [...e2eRuns].filter(([, runs]) => runs !== 1),
    `commands not run exactly once, seed ${SEED}`,
  ).to.deep.equal([]);
}

// The test is about drops, not limits: 1 000 pipelined commands and their resends would otherwise spend most of their time rate-limited.
const UNLIMITED = { http: { socket: { rate: { perSecond: 5_000, burst: 1_000 }, maxInFlightEventsPerConnection: 1_000 } } };
const REPLAYING = { http: { socket: { ...UNLIMITED.http.socket, idempotency: { service: 'DurableE2eReplayStore' } } } };

// Wall-clock budgets, far above the observed values; a slow machine scales them, CI skips them.
const STALL_FACTOR = Number(process.env.E2E_STALL_FACTOR) > 0 ? Number(process.env.E2E_STALL_FACTOR) : 1;
const CHECK_STALLS = !process.env.CI;

describe('W3 end to end: the real client against the real server', function () {
  this.timeout(120_000);
  this.slow(30_000);

  let t: ITestServer;
  let clients: SocketClient[] = [];

  before(() => {
    // eslint-disable-next-line no-console
    console.log(`      durable e2e: seed ${SEED}, ${COMMANDS} commands, ${KILLS} kills ( E2E_SEED, E2E_COMMANDS, E2E_KILLS )`);
  });

  const client = (clientId: string, extra: Partial<SocketClientOptions> = {}) => {
    const c = new SocketClient({ url: t.url, path: t.path, clientId, reconnect: { minMs: 10, maxMs: 50, jitter: 0 }, io: { transports: ['websocket'] }, ...extra });
    clients.push(c);
    return c;
  };

  const online = (c: SocketClient) =>
    new Promise<void>((resolve) => {
      if (c.state === 'online') {
        resolve();
        return;
      }
      const off = c.on('state', (state) => {
        if (state === 'online') {
          off();
          resolve();
        }
      });
    });

  /**
   * Drops the connection `count` times, each once the server has run a seeded share of the first 90 %
   * of `total` commands. A third of the drops lose the reply of a command that just ran.
   */
  const disrupt = async (c: SocketClient, random: () => number, count: number, total: number) => {
    let lostReplies = 0;
    for (let k = 0; k < count; k++) {
      await runsReach(Math.floor((0.9 * total * (k + random())) / count));
      const pause = Math.floor(random() * 6);
      const loseReply = random() < 0.3;

      if (loseReply) {
        ackFaults.drop = 1;
        // only the gated command may be left, and it settles after the schedule ends: drop the plain way then
        await waitFor(() => ackFaults.drop === 0 || e2eRuns.size >= total - 1, 10_000);
        if (ackFaults.drop === 0) {
          lostReplies++;
          continue;
        }
        ackFaults.drop = 0;
      }

      do {
        await online(c);
        await delay(pause);
      } while (killConnections(t) === 0);
    }
    return lostReplies;
  };

  /** The longest time the server ran no command although the client was online, and the sum of such stalls over 100 ms. */
  const stallMeter = (c: SocketClient) => {
    const meter = { enabled: true, max: 0, total: 0, from: Date.now() };
    c.on('state', (state) => {
      if (state === 'online') {
        meter.from = Date.now();
      }
    });
    e2eProbe.onRun = () => {
      const now = Date.now();
      if (meter.enabled && c.state === 'online') {
        const stall = now - meter.from;
        meter.max = Math.max(meter.max, stall);
        meter.total += stall > 100 ? stall : 0;
      }
      meter.from = now;
    };
    return meter;
  };

  beforeEach(() => {
    e2eRuns.clear();
    e2eOrder.length = 0;
    e2eHooks.length = 0;
    e2eProbe.reset();
  });

  afterEach(async () => {
    ackFaults.reset();
    clients.forEach((c) => c.close());
    clients = [];
    await t.close();
  });

  it(`runs ${COMMANDS} durable commands exactly once and in order while the connection is killed ${KILLS} times`, async () => {
    t = await startServer(REPLAYING);
    const random = mulberry32(SEED);
    const c = client('e2e-durable');
    await online(c);
    const meter = stallMeter(c);

    let openGate!: () => void;
    e2eProbe.gate = new Promise<void>((resolve) => (openGate = resolve));
    const resolved: number[] = [];
    const all = Promise.all(range(COMMANDS).map((n) => c.durable<number>('e2e.apply', { n, ms: 1 + Math.floor(random() * 5), gate: n === COMMANDS - 1 }).then((v) => void resolved.push(v))));

    const lostReplies = await disrupt(c, random, KILLS, COMMANDS);
    meter.enabled = false;
    openGate();
    await all;

    const replays = DurableE2eReplayStore.last!.replays;
    // eslint-disable-next-line no-console
    console.log(`      ${KILLS} drops ( ${lostReplies} lost a reply ), ${e2eProbe.requests} requests, ${replays} replays, ${e2eProbe.fenced.length} fenced, refused ${JSON.stringify([...e2eProbe.refused])}, longest stall ${meter.max} ms, stalls over 100 ms ${meter.total} ms`);
    expect(lostReplies, `drops that lost a reply, seed ${SEED}`).to.be.above(0);
    // a lost reply is answered from the store on resend; a rerun would show in the run counts below
    expect(replays, `resends answered from the idempotency store, seed ${SEED}`).to.be.above(0);
    expectExactlyOnceInOrder(COMMANDS, resolved);
    // A fence refusal parks the command behind its predecessor, any other refusal pauses the whole queue with
    // a backoff. Drops alone give the queue no reason to back off.
    expect(
      [...e2eProbe.refused.keys()].filter((kind) => kind !== 'aborted'),
      `refusals other than aborted calls, seed ${SEED}`,
    ).to.deep.equal([]);
    if (CHECK_STALLS) {
      // what a stuck queue looks like: it would wait for the 60 s ack timeout or a backoff ceiling
      expect(meter.max, `longest stall while online, seed ${SEED}`).to.be.below(5_000 * STALL_FACTOR);
      expect(meter.total, `stalls over 100 ms while online, seed ${SEED}`).to.be.below(10_000 * STALL_FACTOR);
    }
  });

  it('keeps the order when a successor reaches the fence before its predecessor', async () => {
    t = await startServer(UNLIMITED);
    const random = mulberry32(SEED + 1);
    e2eProbe.jitterClientId = 'e2e-reorder';
    e2eProbe.jitter = random;
    const c = client('e2e-reorder');
    await online(c);

    const count = 300;
    const resolved: number[] = [];
    const all = Promise.all(range(count).map((n) => c.durable<number>('e2e.apply', { n, ms: 1 }).then((v) => void resolved.push(v))));
    await disrupt(c, random, 10, count);
    await all;

    expectExactlyOnceInOrder(count, resolved);
    expect(e2eProbe.jittered, `jittered requests, seed ${SEED + 1}`).to.be.above(0);
    // without overtakes the fence would never have refused anything
    expect(e2eProbe.fenced.length, `fence refusals, seed ${SEED + 1}`).to.be.above(0);
    expect(
      [...e2eProbe.refused.keys()].filter((kind) => kind !== 'aborted'),
      `refusals other than aborted calls, seed ${SEED + 1}`,
    ).to.deep.equal([]);
  });

  it("runs a durable queue of an idempotent command that is not ordered: 'client' exactly once and in order, past its head", async () => {
    t = await startServer(UNLIMITED);
    const c = client('e2e-loose');
    await online(c);

    const count = 50;
    const resolved: number[] = [];
    await Promise.all(range(count).map((n) => c.durable<number>('e2e.loose', { n, ms: count - n }).then((v) => void resolved.push(v))));

    expectExactlyOnceInOrder(count, resolved);
    expect([...e2eProbe.refused.keys()]).to.deep.equal([]);
  });

  it('does not hold a successor whose predecessor was answered but never stored', async () => {
    t = await startServer({ ...UNLIMITED, http: { socket: { ...UNLIMITED.http.socket, idempotency: { service: 'DurableE2eForgetfulStore' } } } });
    const c = client('e2e-forget');
    await online(c);

    const count = 100;
    const resolved: number[] = [];
    await Promise.all(range(count).map((n) => c.durable<number>('e2e.apply', { n, ms: 2 }).then((v) => void resolved.push(v))));

    expectExactlyOnceInOrder(count, resolved);
    const { forgotten, completions } = DurableE2eForgetfulStore.last!;
    expect(forgotten).to.have.length(range(completions).filter((n) => n % 10 === 3 || n % 10 === 7).length);
    expect(forgotten).to.not.be.empty;
    // the successor of a lost key was fenced on it, and still ran
    expect(e2eProbe.fenced.filter((after) => forgotten.includes(after))).to.not.be.empty;
  });

  it('drains on shutdown: running commands finish, new ones get unavailable, and the queue drains on the restarted server', async () => {
    const cfg = { http: { socket: { drainMs: 3_000, shutdownRetryAfterMs: 100 } } };
    t = await startServer(cfg);
    const c = client('e2e-shutdown');
    await online(c);
    const resolved: number[] = [];
    const all = Promise.all(range(50).map((n) => c.durable<number>('e2e.apply', { n, ms: 20 }).then((v) => void resolved.push(v))));
    await waitFor(() => e2eRuns.size >= 10, 10_000);

    const slow = c.command<string>('e2e.slow', { ms: 500 });
    await delay(20);
    const notice = new Promise((resolve) => c.once('sys.shutdown', resolve));
    // the fault kit's restart, split so the gap between the two servers can be checked
    const { port } = t.host.Http.address() as AddressInfo;
    const closed = t.close();
    await notice;
    const refused = await c.command('e2e.ping').then(
      () => null,
      (error: { code: string }) => error,
    );

    expect(await slow).to.equal('slow done');
    expect(refused).to.include({ code: 'unavailable' });

    await closed;
    const ranBeforeRestart = e2eRuns.size;
    // the drain wrote every reply before the transports closed; the client may still be reading them
    await waitFor(() => resolved.length >= ranBeforeRestart, 2_000).catch(() => undefined);
    expect(resolved, 'commands the old server ran are the ones it answered').to.deep.equal(range(ranBeforeRestart));
    expect(ranBeforeRestart, 'durable commands left for the restarted server').to.be.below(50);

    t = await startServer(cfg, undefined, port);
    await all;

    expectExactlyOnceInOrder(50, resolved);
  });

  it('resumes a FileOutboxStore queue in a new client on the same file and acknowledges each command once', async () => {
    t = await startServer(REPLAYING);
    const dir = await mkdtemp(join(tmpdir(), 'e2e-outbox-'));
    const path = join(dir, 'outbox.json');
    const random = mulberry32(SEED + 2);
    const count = 150;

    try {
      const a = client('e2e-file', { outbox: new FileOutboxStore(path) });
      await online(a);
      const resolvedByA: number[] = [];
      const waiting = range(count).map((n) =>
        a.durable<number>('e2e.apply', { n, ms: 1 + Math.floor(random() * 3) }).then(
          (v) => void resolvedByA.push(v),
          (error: { code: string }) => error.code,
        ),
      );

      await runsReach(40);
      killConnections(t);
      await online(a);
      await runsReach(70);
      // the next client opens the file only once this one has no write in flight
      await a.close();
      expect(await Promise.all(waiting)).to.include('unavailable');

      const second = new FileOutboxStore(path);
      const ackedByB: number[] = [];
      const b = client('e2e-file', { outbox: second });
      b.on('acked', ({ result }) => void ackedByB.push(result as number));
      await waitFor(() => resolvedByA.length + ackedByB.length >= count, 30_000);

      expect(resolvedByA.length, `answered before the reload, seed ${SEED + 2}`).to.be.within(1, count - 1);
      // what A's server ran but A never heard of is answered to B from the store
      expect(DurableE2eReplayStore.last!.replays, `resends answered from the idempotency store, seed ${SEED + 2}`).to.be.above(0);
      expectExactlyOnceInOrder(count, [...resolvedByA, ...ackedByB]);
      expect(await second.pending()).to.deep.equal([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('replays room events missed during a 5 s drop, and the connect hooks see the recovery', async () => {
    t = await startServer();
    const c = client('e2e-rooms', { reconnect: { minMs: 5_000, maxMs: 5_000, jitter: 0 } });
    await online(c);
    await c.command('e2e.join');
    const news: unknown[] = [];
    c.on('e2e.news', (payload) => news.push(payload));
    const hub = DI.resolve(SocketHub);

    // the client asks for recovery only once it holds the offset of a received push; acks carry none
    hub.to('e2e-room').emit('e2e.news', { n: 0 });
    await waitFor(() => news.length === 1);

    killConnections(t);
    await delay(200);
    expect(c.state).to.equal('offline');
    hub.to('e2e-room').emit('e2e.news', { n: 1 });

    await waitFor(() => news.length === 2, 10_000);
    expect(news).to.deep.equal([{ n: 0 }, { n: 1 }]);
    expect(e2eHooks).to.deep.equal([false, true]);
  });
});
