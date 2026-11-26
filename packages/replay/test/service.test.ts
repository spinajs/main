import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { useTestApp } from '@spinajs/testing';

import { DomainReplayService, RecordingSource, RecordingUnreadable, ReplayBudgetExceeded, ReplayBusy, ReplayHistory, ReplayService, Replayer, StateSource } from '../src/index.js';
import type { ChangePage, ChangeReader, KeyState, Recording, ReplayBudget, ReplayChange, ReplayMissing, ReplayOutcome, ReplayWindow, StateView } from '../src/index.js';
import { MemoryChangeReader } from '../src/testing.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
const T = new Date('2026-11-17T12:00:00.000Z');
const SAFE = Number.MAX_SAFE_INTEGER;

type Step = (recording: Recording, view: StateView, signal: AbortSignal, budget: ReplayBudget) => Promise<ReplayOutcome>;
interface World {
  recordings: Map<string, Recording | Error | Promise<Recording>>;
  step: Step;
  views: { at: Date; window: ReplayWindow; budget: ReplayBudget }[];
  budgets: ReplayBudget[];
  reader: ChangeReader;
  reads: number;
}

const answer = (outcome: unknown, more: Partial<ReplayOutcome> = {}): Promise<ReplayOutcome> => Promise.resolve({ outcome, missing: [], divergences: [], ...more });
const echo: Step = (r) => answer(r.outcome);
const world: World = { recordings: new Map(), step: echo, views: [], budgets: [], reader: new MemoryChangeReader(), reads: 0 };

const recording = (domain: string, id: string, more: Partial<Recording> = {}): Recording => ({ id, domain, at: T, now: T, durationMs: 40, outcome: { price: 12 }, versions: {}, payload: {}, ...more });
const gap = { input: 'tuple', key: 'k1', reason: 'the tuple history starts nowhere (not covered)' };

abstract class Recordings extends RecordingSource {
  load(id: string): Promise<Recording | undefined> {
    const r = world.recordings.get(`${this.domain}/${id}`);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}
class PricingRecordings extends Recordings {
  readonly domain = 'pricing';
}
class QuoteRecordings extends Recordings {
  readonly domain = 'quotes';
}

abstract class Steps extends Replayer {
  replay(recording: Recording, view: StateView, signal: AbortSignal, budget: ReplayBudget): Promise<ReplayOutcome> {
    world.budgets.push(budget);
    return world.step(recording, view, signal, budget);
  }
}
class PricingReplayer extends Steps {
  readonly domain = 'pricing';
}
class SecondPricingReplayer extends Steps {
  readonly domain = 'pricing';
}
class QuoteReplayer extends Steps {
  readonly domain = 'quotes';
}

const changedInWindow = (entity: string, id: string): KeyState => ({ known: false, reason: `${entity} ${id} changed inside the window` });

// A view over a real ReplayHistory of `world.reader`, loaded with the budget and the window the service gives.
class State extends StateSource {
  view(at: Date, window: ReplayWindow, budget: ReplayBudget, signal: AbortSignal): StateView {
    world.views.push({ at, window, budget });
    let history: Promise<ReplayHistory> | undefined;
    const keys = async (entity: string, ids: readonly string[]): Promise<ReadonlyMap<string, KeyState>> => {
      world.reads++;
      const h = await (history ??= ReplayHistory.load(world.reader, at, ['tuple'], { ...budget, window }, signal));
      h.reserve(entity, ids);
      return new Map(ids.map((id): [string, KeyState] => [id, h.afterFor(entity, id).length > 0 ? changedInWindow(entity, id) : { known: true, value: undefined, origin: 'current' }]));
    };
    return { at, keys, select: () => Promise.resolve({ rows: [], gaps: [] }) };
  }
}
class SecondState extends State {}

// Reads key k of the view: the recorded outcome when its state is known, else unknown with the gap.
const readsK: Step = async (r, view) => {
  const k = (await view.keys('tuple', ['k'])).get('k');
  return k?.known === true ? answer(r.outcome) : answer('unknown', { missing: [{ input: 'tuple', key: 'k', reason: k?.reason ?? 'absent' }] });
};
// A replayer that breaks its contract: it swallows a failed read and answers the recorded outcome anyway.
const swallowsK: Step = async (r, view) => {
  await view.keys('tuple', ['k']).catch(() => undefined);
  return answer(r.outcome);
};

const change = (seq: number): ReplayChange => ({ entity: 'tuple', key: `k${seq}`, op: 'add', image: { seq }, before: null, at: new Date(T.getTime() + 60_000), seq, traceId: null });
// Answers one page whose seqs go back, then empty pages: the history refuses the first, and nothing here can loop.
class BackwardsReader implements ChangeReader {
  private pages = 0;
  afterInstant(_entity: string, _at: Date, _page: ChangePage): Promise<readonly ReplayChange[]> {
    return Promise.resolve(this.pages++ === 0 ? [change(2), change(1)] : []);
  }
  latest = (): Promise<ReadonlyMap<string, ReplayChange>> => Promise.resolve(new Map());
  coveredSince = (): Promise<Date | undefined> => Promise.resolve(undefined);
}

async function untilAborted(signal: AbortSignal): Promise<ReplayOutcome> {
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  signal.throwIfAborted();
  return { outcome: 'unknown', missing: [], divergences: [] };
}

const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

interface Gate<T> {
  promise: Promise<T>;
  open(value: T): void;
  fail(error: unknown): void;
}
function gate<T>(): Gate<T> {
  let open: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}
const heldReader = (page: Promise<readonly ReplayChange[]>): ChangeReader => ({ afterInstant: () => page, latest: () => Promise.resolve(new Map()), coveredSince: () => Promise.resolve(undefined) });
const unwaited = (n: number): ReplayMissing => ({ input: 'state', reason: `the replayer answered without waiting for ${n} of its reads of the state` });
const timedOut = [{ input: 'timeout', reason: 'the replay ran past timeoutMs 300' }];

// A service that does not end the call fails here by assertion, not by mocha's timeout.
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`the replay still runs after ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const note = (e: unknown): void => void seen.push(e);
  process.on('unhandledRejection', note);
  try {
    await body();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', note);
  }
  return seen;
}

const parts = (c: IContainer): void => {
  c.register(PricingRecordings).as(RecordingSource);
  c.register(QuoteRecordings).as(RecordingSource);
  c.register(PricingReplayer).as(Replayer);
  c.register(QuoteReplayer).as(Replayer);
  c.register(State).as(StateSource);
};

function reset(): void {
  world.recordings.clear();
  world.recordings.set('pricing/r1', recording('pricing', 'r1'));
  world.step = echo;
  world.views.length = 0;
  world.budgets.length = 0;
  world.reader = new MemoryChangeReader();
  world.reads = 0;
}

describe('DomainReplayService', function () {
  this.timeout(60000);

  const app = useTestApp(() => ({ config: { logger: SILENT, replay: { timeoutMs: 300, domains: { pricing: { maxKeys: 700 }, quotes: { concurrency: 1 } } } }, register: parts }));
  const service = (): Promise<ReplayService> => app().resolve(ReplayService);

  beforeEach(reset);

  it('is the registered ReplayService and replays a recording with the window and the budget of its domain', async () => {
    const s = await service();
    expect(s).to.be.instanceOf(DomainReplayService);
    world.step = () => answer({ price: 12 }, { evidence: 'inputs-hash', tree: { steps: 3 } });
    expect(await s.replay('pricing', 'r1')).to.deep.equal({ id: 'r1', domain: 'pricing', replay: 'faithful', evidence: 'inputs-hash', missing: [], divergences: [], tree: { steps: 3 } });
    expect(world.views).to.deep.equal([{ at: T, window: { beforeMs: 6_040, afterMs: 1_000 }, budget: { maxChanges: 50_000, maxKeys: 700 } }]);
    expect(world.budgets).to.deep.equal([{ maxChanges: 50_000, maxKeys: 700 }]);
    world.step = () => answer({ price: 13 });
    expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'divergent', divergences: [{ part: 'outcome', recorded: '{"price":12}', replayed: '{"price":13}' }] });
  });

  it('answers undefined for an id the domain does not hold, caps maxChanges at the hard ceiling and refuses one that is no positive integer', async () => {
    const s = await service();
    expect(await s.replay('pricing', 'nope')).to.equal(undefined);
    expect(world.views).to.deep.equal([]);
    await s.replay('pricing', 'r1', { maxChanges: 10 });
    await s.replay('pricing', 'r1', { maxChanges: 900_000 });
    expect(await failure(s.replay('pricing', 'r1', { maxChanges: Number.NaN }))).to.be.instanceOf(InvalidOperation).with.property('message', 'replay: maxChanges must be a positive integer, not NaN');
    expect(await failure(s.replay('pricing', 'r1', { maxChanges: 0 }))).to.be.instanceOf(InvalidOperation);
    expect(world.views.map((v) => v.budget.maxChanges)).to.deep.equal([10, 500_000]);
    expect(world.budgets.map((b) => b.maxChanges)).to.deep.equal([10, 500_000]);
  });

  it('reports an unreadable recording, one of another domain, or one whose window leaves the calendar as unreplayable without replaying it', async () => {
    world.recordings.set('pricing/bad', new RecordingUnreadable('the payload column is not JSON'));
    world.recordings.set('pricing/moved', recording('quotes', 'moved'));
    world.recordings.set('pricing/endless', recording('pricing', 'endless', { durationMs: 1e16 }));
    world.recordings.set('pricing/lost', new Error('connection reset'));
    world.step = readsK;
    const s = await service();
    expect(await s.replay('pricing', 'bad')).to.deep.equal({ id: 'bad', domain: 'pricing', replay: 'unreplayable', missing: [{ input: 'record', reason: 'the record is not readable: the payload column is not JSON' }], divergences: [] });
    expect((await s.replay('pricing', 'moved'))?.missing).to.deep.equal([{ input: 'record', reason: 'the recording belongs to the domain quotes' }]);
    expect((await s.replay('pricing', 'endless'))?.missing).to.deep.equal([{ input: 'record', reason: 'the window of the recording, 10000000000006000 ms before 2026-11-17T12:00:00.000Z, starts before the earliest instant a Date holds' }]);
    expect(world.views).to.deep.equal([]);
    expect(await failure(s.replay('pricing', 'lost'))).to.be.instanceOf(Error).with.property('message', 'connection reset');
  });

  it('turns a history budget or the timeout into unreplayable, and rethrows any other fault', async () => {
    const s = await service();
    world.step = () => Promise.reject(new ReplayBudgetExceeded('maxChanges', 50_001));
    expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'unreplayable', missing: [{ input: 'history-budget', key: 'maxChanges', reason: 'the replay read 50001 changes, past its maxChanges' }] });
    world.step = (_r, _v, signal) => untilAborted(signal);
    expect((await within(2_000, s.replay('pricing', 'r1')))?.missing).to.deep.equal(timedOut);
    world.step = () => Promise.reject(new TypeError('boom'));
    expect(await failure(s.replay('pricing', 'r1'))).to.be.instanceOf(TypeError);
  });

  it('stops a history read past the maxChanges of the call as unreplayable, also when the replayer swallows the stop or tries to raise its budget', async () => {
    world.reader = new MemoryChangeReader().append(Array.from({ length: 11 }, (_, i) => ({ entity: 'tuple', op: 'add' as const, key: `k${i}`, at: new Date(T.getTime() + 1_000) })));
    world.step = readsK;
    const s = await service();
    expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'faithful' });
    const stop = [{ input: 'history-budget', key: 'maxChanges', reason: 'the replay read 11 changes, past its maxChanges' }];
    expect(await s.replay('pricing', 'r1', { maxChanges: 10 })).to.deep.include({ replay: 'unreplayable', missing: stop });
    world.step = swallowsK;
    expect(await s.replay('pricing', 'r1', { maxChanges: 10 })).to.deep.include({ replay: 'unreplayable', missing: stop });
    world.step = (r, view, signal, budget) => {
      Reflect.set(budget, 'maxChanges', 500_000);
      return readsK(r, view, signal, budget);
    };
    expect(await s.replay('pricing', 'r1', { maxChanges: 10 })).to.deep.include({ replay: 'unreplayable', missing: stop });
  });

  it('rejects with the error of a page the history refuses, also when the replayer swallows it, and never reports it', async () => {
    const s = await service();
    for (const step of [readsK, swallowsK]) {
      world.reader = new BackwardsReader();
      world.step = step;
      const e = await failure(s.replay('pricing', 'r1'));
      expect(e).to.be.instanceOf(Error).and.not.be.instanceOf(ReplayBudgetExceeded);
      expect(e).to.have.property('message').that.contains('ReplayHistory: BackwardsReader answered a page of tuple after seq none that holds seq 1, not above seq 2 before it');
    }
  });

  it('rejects with the error of a history a failed pass left answering nothing, never as a budget stop', async () => {
    const reader = new MemoryChangeReader();
    world.step = async (r, _view, signal, budget) => {
      const own = await ReplayHistory.load(reader, r.at, ['tuple'], { ...budget, window: { beforeMs: 0, afterMs: 0 } }, signal);
      reader.append(Array.from({ length: 11 }, (_, i) => ({ entity: 'tuple', op: 'add' as const, key: `k${i}`, at: new Date(Date.now() + 60_000) })));
      await own.catchUp().catch(() => undefined);
      return answer(own.afterFor('tuple', 'k0').length === 0 ? r.outcome : 'unknown');
    };
    const s = await service();
    const e = await failure(s.replay('pricing', 'r1', { maxChanges: 10 }));
    expect(e).to.be.instanceOf(Error).with.property('message').that.matches(/^ReplayHistory: the last catchUp failed/);
    expect(e).to.have.property('cause').that.is.instanceOf(ReplayBudgetExceeded);
  });

  it('a view read that failed decides the replay even when the replayer answers an outcome', async () => {
    const down = new Error('the trail table is gone');
    world.reader = { afterInstant: () => Promise.reject(down), latest: () => Promise.resolve(new Map()), coveredSince: () => Promise.resolve(undefined) };
    world.step = swallowsK;
    const s = await service();
    expect(await failure(s.replay('pricing', 'r1'))).to.equal(down);
  });

  it('P1: a view read still running when the replayer answers makes the replay unreplayable, and its later failure changes nothing', async () => {
    const page = gate<readonly ReplayChange[]>();
    world.reader = heldReader(page.promise);
    let late: Promise<unknown> = Promise.resolve();
    world.step = (r, view) => {
      late = failure(view.keys('tuple', ['k']));
      return answer(r.outcome);
    };
    const s = await service();
    const report = await s.replay('pricing', 'r1');
    page.fail(new Error('the trail table is gone'));
    expect(await late).to.be.instanceOf(Error);
    expect(report).to.deep.include({ replay: 'unreplayable', missing: [unwaited(1)] });
  });

  it('reports a view read still running when the replayer answers as unreplayable also when it succeeds afterwards: the replayer did not wait for it', async () => {
    const page = gate<readonly ReplayChange[]>();
    world.reader = heldReader(page.promise);
    const late: Promise<unknown>[] = [];
    world.step = (r, view) => {
      late.push(failure(view.keys('tuple', ['k'])), failure(view.keys('tuple', ['j'])));
      return answer(r.outcome);
    };
    const s = await service();
    const report = await within(2_000, s.replay('pricing', 'r1'));
    page.open([]);
    await Promise.all(late);
    expect(report).to.deep.include({ replay: 'unreplayable', missing: [unwaited(2)] });
  });

  it('rejects a read of the view issued after the replay ended, without reading and without an unhandled rejection', async () => {
    const kept: StateView[] = [];
    world.step = (r, view) => {
      kept.push(view);
      return answer(r.outcome);
    };
    const s = await service();
    const seen = await unhandledDuring(async () => {
      expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'faithful' });
      expect(await failure(kept[0].keys('tuple', ['k']))).to.be.instanceOf(InvalidOperation).with.property('message', 'replay: the replay has ended; its view of the state reads nothing more');
      expect(await failure(kept[0].select('tuple', {}))).to.be.instanceOf(InvalidOperation);
    });
    expect(seen).to.deep.equal([]);
    expect(world.reads).to.equal(0);
  });

  it('gives each replay its own view: a read of an ended replay, failing or still running, never reaches a replay that runs after it', async () => {
    world.recordings.set('pricing/r2', recording('pricing', 'r2'));
    const [failing, running, go] = [gate<readonly ReplayChange[]>(), gate<readonly ReplayChange[]>(), gate<undefined>()];
    const kept: StateView[] = [];
    world.step = async (r, view, signal, budget) => {
      if (r.id === 'r2') return go.promise.then(() => readsK(r, view, signal, budget));
      kept.push(view);
      void view.keys('tuple', ['k']).catch(() => undefined);
      return answer(r.outcome);
    };
    const s = await service();
    for (const page of [failing, running]) {
      world.reader = heldReader(page.promise);
      expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'unreplayable', missing: [unwaited(1)] });
    }
    world.reader = new MemoryChangeReader();
    const second = s.replay('pricing', 'r2');
    failing.fail(new Error('the trail table is gone'));
    expect(await failure(kept[0].keys('tuple', ['k']))).to.be.instanceOf(InvalidOperation);
    go.open(undefined);
    expect(await within(2_000, second)).to.deep.include({ replay: 'faithful' });
    running.open([]);
  });

  it('ends at the timeout a replayer that ignores its signal, keeps its slot until it settles, and swallows its late answer or rejection', async () => {
    world.recordings.set('quotes/q1', recording('quotes', 'q1'));
    const late: [Gate<ReplayOutcome>, (held: Gate<ReplayOutcome>) => void][] = [
      [gate(), (held) => held.open({ outcome: { price: 12 }, missing: [], divergences: [] })],
      [gate(), (held) => held.fail(new Error('too late'))],
    ];
    const s = await service();
    const seen = await unhandledDuring(async () => {
      for (const [held, settle] of late) {
        world.step = () => held.promise;
        expect(await within(2_000, s.replay('quotes', 'q1'))).to.deep.include({ replay: 'unreplayable', missing: timedOut });
        expect(await failure(s.replay('quotes', 'q1'))).to.be.instanceOf(ReplayBusy);
        settle(held);
        await failure(held.promise);
      }
      world.step = echo;
      expect(await s.replay('quotes', 'q1')).to.deep.include({ replay: 'faithful' });
    });
    expect(seen).to.deep.equal([]);
  });

  it('reports an unknown outcome with missing inputs as unreplayable with them, never faithful, and a determined one as faithful (ReplayOutcome asserts no missing input could change it)', async () => {
    world.recordings.set('pricing/u', recording('pricing', 'u', { outcome: 'unknown' }));
    const s = await service();
    world.step = () => answer('unknown', { missing: [gap] });
    expect(await s.replay('pricing', 'u')).to.deep.equal({ id: 'u', domain: 'pricing', replay: 'unreplayable', missing: [gap], divergences: [] });
    expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'unreplayable', missing: [gap] });
    world.step = (r) => answer(r.outcome, { missing: [gap] });
    expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'faithful', missing: [] });
  });

  it('rejects with the reason of a caller that aborts, before, while the recording loads, or during the replay', async () => {
    const s = await service();
    const gone = new Error('the client went away');
    expect(await failure(s.replay('pricing', 'r1', { signal: AbortSignal.abort(gone) }))).to.equal(gone);
    const loading = gate<Recording>();
    world.recordings.set('pricing/slow', loading.promise);
    const during = new AbortController();
    const slow = failure(s.replay('pricing', 'slow', { signal: during.signal }));
    during.abort(gone);
    loading.open(recording('pricing', 'slow'));
    expect(await slow).to.equal(gone);
    expect([world.views, world.budgets]).to.deep.equal([[], []]);
    const caller = new AbortController();
    world.step = (_r, _v, signal) => untilAborted(signal);
    const pending = failure(s.replay('pricing', 'r1', { signal: caller.signal }));
    caller.abort(gone);
    expect(await pending).to.equal(gone);
    const held = gate<ReplayOutcome>();
    world.step = () => held.promise;
    const ignored = new AbortController();
    const ignoring = failure(within(2_000, s.replay('pricing', 'r1', { signal: ignored.signal })));
    ignored.abort(gone);
    expect(await ignoring).to.equal(gone);
    held.open({ outcome: { price: 12 }, missing: [], divergences: [] });
  });

  it('reports a recording dated later than this process clock plus clockSkewMs as unreplayable without replaying it', async () => {
    const s = await service();
    const clock = Date.now;
    try {
      Date.now = (): number => T.getTime() - 1_001;
      expect((await s.replay('pricing', 'r1'))?.missing).to.deep.equal([{ input: 'record', reason: "the recording's instant 2026-11-17T12:00:00.000Z is 1001 ms after this process's clock, past clockSkewMs 1000" }]);
      expect(world.views).to.deep.equal([]);
      Date.now = (): number => T.getTime() - 1_000;
      expect((await s.replay('pricing', 'r1'))?.replay).to.equal('faithful');
    } finally {
      Date.now = clock;
    }
  });

  it('refuses a replay past the concurrency of its domain with ReplayBusy, each domain counted on its own', async () => {
    world.recordings.set('quotes/q1', recording('quotes', 'q1'));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.step = async (r) => {
      await gate;
      return { outcome: r.outcome, missing: [], divergences: [] };
    };
    const s = await service();
    const held = [s.replay('pricing', 'r1'), s.replay('pricing', 'r1'), s.replay('quotes', 'q1')];
    const busy = await failure(s.replay('pricing', 'r1'));
    expect(busy).to.be.instanceOf(ReplayBusy).and.include({ domain: 'pricing', concurrency: 2 });
    expect(busy).to.have.property('message', 'replay: 2 pricing replays are running in this process already (replay.domains.pricing.concurrency, else replay.concurrency)');
    expect(await failure(s.replay('quotes', 'q1'))).to.be.instanceOf(ReplayBusy).and.include({ domain: 'quotes', concurrency: 1 });
    release();
    expect((await Promise.all(held)).map((r) => r?.replay)).to.deep.equal(['faithful', 'faithful', 'faithful']);
    expect((await s.replay('pricing', 'r1'))?.replay).to.equal('faithful');
  });

  it('refuses a domain it cannot serve and a part registered twice', async () => {
    const s = await service();
    expect(await failure(s.replay('billing', 'b1'))).to.be.instanceOf(InvalidOperation).with.property('message', 'replay: no RecordingSource is registered for the domain billing');
    app().container.register(SecondPricingReplayer).as(Replayer);
    expect(await failure(s.replay('pricing', 'r1'))).to.be.instanceOf(InvalidOperation).with.property('message', 'replay: Replayer is registered 2 times for the domain pricing; keep one');
    app().container.register(SecondState).as(StateSource);
    expect(await failure(s.replay('quotes', 'q1'))).to.be.instanceOf(InvalidOperation).with.property('message', 'replay: StateSource is registered 2 times in this process; keep one');
  });
});

describe('DomainReplayService at the widest limits the schema takes', function () {
  this.timeout(60000);

  const widest = { maxChanges: 500_000, maxKeys: SAFE, maxDepth: SAFE, maxCalls: SAFE, timeoutMs: 2_147_483_647, concurrency: SAFE, clockSkewMs: 2_147_483_647, commitLagMs: 2_147_483_647 };
  const app = useTestApp(() => ({ config: { logger: SILENT, replay: widest }, register: parts }));

  beforeEach(reset);

  it('hands the history limits it accepts and still sees a change inside the window', async () => {
    world.reader = new MemoryChangeReader().append([{ entity: 'tuple', op: 'put', key: 'k', at: new Date(T.getTime() - 3_000_000_000) }]);
    world.step = readsK;
    const s = await app().resolve(ReplayService);
    expect(await s.replay('pricing', 'r1')).to.deep.include({ replay: 'unreplayable', missing: [{ input: 'tuple', key: 'k', reason: 'tuple k changed inside the window' }] });
    expect(world.views[0].window).to.deep.equal({ beforeMs: 40 + 2 * 2_147_483_647, afterMs: 2_147_483_647 });
  });
});
