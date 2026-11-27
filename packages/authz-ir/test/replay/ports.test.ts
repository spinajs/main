import 'mocha';
import { expect } from 'chai';
import { resourceKey } from '@spinajs/authz';
import type { ChangeKind, DecisionRecord, Principal, ReplayReport, ResourceRef } from '@spinajs/authz';

import { MemoryChangeLog, ReplayBudgetExceeded, canonicalize, changeLogKeyState, changeLogReplay, coverageGap, policyHash, replayBudgetStop, replayDecision, replayWindow, sameImage, stateAt } from '../../src/index.js';
import type { AttributeHistoryContributor, KeyState, PolicyIR, ReplayChange, ReplayDeps, ReplayHistoryLimits, ReplayHistoryView, ReplayWindow } from '../../src/index.js';
import { TupleStore } from '../fixtures/history-store.js';
import { tapped } from '../fixtures/tap.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const MIN = 60_000;
const limits = { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: 6_000, afterMs: 1_000 }, now: () => T.getTime() + 60 * MIN };

describe('replay ports: the changelog implementation', () => {
  it('loads a history view over the log', async () => {
    const log = new MemoryChangeLog().cover('tuple', ms(-60 * MIN));
    await log.append([
      { kind: 'tuple', op: 'add', key: 'k1', payload: { v: 1 }, at: ms(-30 * MIN) },
      { kind: 'tuple', op: 'remove', key: 'k1', payload: { v: 1 }, at: ms(10 * MIN) },
    ]);
    const view: ReplayHistoryView = await changeLogReplay(log).history(T, ['tuple'], limits);
    expect(view.at).to.equal(T);
    expect(view.kinds).to.deep.equal(['tuple']);
    expect(view.window).to.deep.equal(limits.window);
    expect(view.precisionMs).to.equal(1);
    expect(view.changes).to.equal(1);
    expect(view.afterFor('tuple', 'k1').map((c) => c.seq)).to.deep.equal([2]);
    expect([...view.changesOf('tuple')].map((c) => c.op)).to.deep.equal(['remove']);
    expect((await view.beforeOf('tuple', ['k1'])).get('k1')).to.include({ seq: 1, op: 'add' });
    expect((await view.headOf('tuple', ['k1'])).get('k1')).to.include({ seq: 2 });
    expect(view.keys).to.equal(1);
    expect(await view.since('tuple')).to.deep.equal(ms(-60 * MIN));
  });

  it('hands out the key-state rules of the changelog', () => {
    expect(changeLogKeyState.stateAt).to.equal(stateAt);
    expect(changeLogKeyState.coverageGap).to.equal(coverageGap);
    expect(changeLogKeyState.sameImage).to.equal(sameImage);
    expect(changeLogReplay(new MemoryChangeLog()).keyState).to.equal(changeLogKeyState);
  });

  it('reads a budget stop by its shape, whatever class threw it', () => {
    expect(replayBudgetStop(new ReplayBudgetExceeded('maxKeys', 3))).to.deep.equal({ limit: 'maxKeys', count: 3 });
    expect(replayBudgetStop(Object.assign(new Error('scan stopped'), { limit: 'maxChanges', count: 7 }))).to.deep.equal({ limit: 'maxChanges', count: 7 });
    expect(replayBudgetStop(Object.assign(new Error('other'), { limit: 'maxDepth', count: 7 }))).to.equal(undefined);
    expect(replayBudgetStop(Object.assign(new Error('other'), { limit: 'maxKeys', count: '7' }))).to.equal(undefined);
    expect(replayBudgetStop(new Error('plain'))).to.equal(undefined);
    expect(replayBudgetStop({ limit: 'maxKeys', count: 3 })).to.equal(undefined);
  });
});

const HOUR = 3_600_000;
const LIMITS = { maxChanges: 1000, maxKeys: 1000, maxDepth: 8, maxCalls: 10_000, clockSkewMs: 1000, commitLagMs: 5000, timeoutMs: 15_000 };
const ORG: ResourceRef = { type: 'org', id: 'o1' };
const USER: Principal = { type: 'user', id: 'u1', authenticated: true, source: 'test', attributes: {} };
const EDITOR = { object: { type: 'doc', id: 'd1' }, relation: 'editor', subject: { type: 'user', id: 'u1' } };
const TUPLE_KEY = 'doc:d1#editor@user:u1';

/** Edit needs an editor of a doc whose org has `level` 2 or more. */
const IR: PolicyIR = {
  version: 1,
  types: { user: { relations: {}, permissions: {} }, doc: { relations: { editor: { allowed: ['user'], source: { kind: 'tuples', store: 't' } } }, permissions: { edit: { caveat: 'senior', of: { computed: 'editor' } } } } },
  permissions: { 'doc:edit': { type: 'doc', relation: 'edit', list: false, source: { origin: 'test' } } },
  caveats: { senior: { params: {}, expr: { attr: 'scope.org.level', gte: 2 } } },
  combine: { default: { algorithm: 'deny-overrides' } },
  principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
  opaque: [],
};

/** A history view over an array of changes: nothing of the authz changelog is behind it. */
class ArrayHistory implements ReplayHistoryView {
  readonly precisionMs = 1;
  private readonly resolved = new Set<string>();

  constructor(
    readonly at: Date,
    readonly kinds: readonly ChangeKind[],
    readonly window: ReplayWindow,
    private readonly rows: readonly ReplayChange[],
    private readonly covered: Date,
  ) {}

  get changes(): number {
    return this.scanned().length;
  }

  get keys(): number {
    return this.resolved.size;
  }

  afterFor(kind: ChangeKind, key: string): readonly ReplayChange[] {
    return this.scanned().filter((c) => c.kind === kind && c.key === key);
  }

  changesOf(kind: ChangeKind): Iterable<ReplayChange> {
    return this.scanned().filter((c) => c.kind === kind);
  }

  catchUp(): Promise<void> {
    return Promise.resolve();
  }

  beforeOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ReplayChange>> {
    return Promise.resolve(this.last(kind, keys, this.at));
  }

  headOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ReplayChange>> {
    this.reserve(kind, keys);
    return Promise.resolve(this.last(kind, keys));
  }

  reserve(kind: ChangeKind, keys: readonly string[]): void {
    for (const k of keys) this.resolved.add(`${kind} ${k}`);
  }

  since(): Promise<Date | undefined> {
    return Promise.resolve(this.covered);
  }

  private scanned(): ReplayChange[] {
    const edge = this.at.getTime() - this.window.beforeMs;
    return this.rows.filter((c) => this.kinds.includes(c.kind) && c.at.getTime() >= edge);
  }

  private last(kind: ChangeKind, keys: readonly string[], at?: Date): Map<string, ReplayChange> {
    const out = new Map<string, ReplayChange>();
    for (const c of this.rows) if (c.kind === kind && keys.includes(c.key) && (at === undefined || c.at <= at)) out.set(c.key, c);
    return out;
  }
}

interface Load {
  at: Date;
  kinds: readonly ChangeKind[];
  limits: ReplayHistoryLimits;
  signal: AbortSignal | undefined;
}

interface World {
  record: DecisionRecord;
  t: Date;
  /** Where the tuple store writes its changes; the replay under test never reads it. */
  written: MemoryChangeLog;
  store: TupleStore;
  loads: Load[];
  deps: ReplayDeps;
}

/** u1 edits doc:d1 as its editor since an hour before the decision, which captured org:o1 with `level` 3. */
async function world(): Promise<World> {
  const record = await tapped(IR, USER, {}, true, { attributes: [{ ref: ORG, path: '', value: { level: 3 } }] });
  const t = new Date(record.loggedAt!);
  const written = new MemoryChangeLog();
  const store = new TupleStore(written);
  await store.add(EDITOR, new Date(t.getTime() - HOUR));
  const loads: Load[] = [];
  const attributes: AttributeHistoryContributor = {
    kind: 'attribute',
    key: (scope, path) => `${resourceKey(scope)}#${path}`,
    current: () => Promise.resolve([{ scope: resourceKey(ORG), path: 'level', value: 3 }]),
  };
  const deps: ReplayDeps = {
    history: async (at, kinds, l, signal) => {
      loads.push({ at, kinds, limits: l, signal });
      return new ArrayHistory(at, kinds, l.window, await written.since(0), new Date(t.getTime() - 2 * HOUR));
    },
    keyState: changeLogKeyState,
    loadPolicy: (h) => Promise.resolve(h === policyHash(IR) ? canonicalize(IR) : undefined),
    contributors: [store],
    splicers: [],
    attributes,
    limits: LIMITS,
    now: () => t.getTime() + HOUR,
  };
  return { record, t, written, store, loads, deps };
}

const timeless = (r: ReplayReport): ReplayReport => ({ ...r, limits: { ...r.limits, durationMs: 0 } });

describe('replay ports: replayDecision', function () {
  this.timeout(30_000);

  it('replays over a history no changelog is behind, with the report the changelog implementation gives', async () => {
    const w = await world();
    await w.store.remove(EDITOR, new Date(w.t.getTime() + HOUR / 2));
    const report = await replayDecision(w.record, w.deps);
    expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', outcome: { recorded: 'allow', replayed: 'allow' } });
    expect(report.reads).to.deep.include({ kind: 'tuple', key: TUPLE_KEY, origin: 'history', seq: 2 });
    expect(report.reads).to.deep.include({ kind: 'attribute', key: 'org:o1#level', origin: 'current' });
    expect(report.limits.changes).to.equal(1);

    expect(w.loads).to.have.length(1);
    expect(w.loads[0].at.getTime()).to.equal(w.t.getTime());
    expect(w.loads[0].kinds).to.deep.equal(['tuple', 'attribute']);
    expect(w.loads[0].limits).to.deep.include({ maxChanges: 1000, maxKeys: 1000, window: replayWindow(w.record, LIMITS) });
    expect(w.loads[0].signal).to.be.instanceOf(AbortSignal);

    const since = new Date(w.t.getTime() - 2 * HOUR);
    const viaLog = await replayDecision(w.record, { ...w.deps, ...changeLogReplay(w.written.cover('tuple', since).cover('attribute', since)) });
    expect(timeless(report)).to.deep.equal(timeless(viaLog));
    expect(w.loads).to.have.length(1);
  });

  it('asks the key-state functions it was given for every key and every coverage', async () => {
    const w = await world();
    const gap: KeyState = { known: false, reason: 'stand-in' };
    const report = await replayDecision(w.record, { ...w.deps, keyState: { ...changeLogKeyState, stateAt: () => gap } });
    expect(report.replay).to.equal('unreplayable');
    expect(report.reads).to.deep.include({ kind: 'tuple', key: TUPLE_KEY, origin: 'gap', reason: 'stand-in' });
    expect(report.missing).to.deep.include({ input: 'tuple', key: TUPLE_KEY, reason: 'stand-in' });

    const uncovered = await replayDecision(w.record, { ...w.deps, keyState: { ...changeLogKeyState, coverageGap: () => 'stand-in coverage' } });
    expect(uncovered.replay).to.equal('unreplayable');
    expect(uncovered.reads).to.deep.include({ kind: 'tuple', key: 'doc:d1#editor', origin: 'gap', reason: 'stand-in coverage' });
  });

  it('compares a captured leaf with the sameImage it was given', async () => {
    const w = await world();
    expect((await replayDecision(w.record, w.deps)).replay).to.equal('faithful');
    const report = await replayDecision(w.record, { ...w.deps, keyState: { ...changeLogKeyState, sameImage: () => false } });
    expect(report.replay).to.equal('divergent');
    expect(report.divergence).to.deep.equal([{ part: 'captured-state', key: 'org:o1#level', recorded: '3', replayed: '3' }]);
  });

  it('reports a budget stop of the loader or of the view as the history budget, and rethrows any other failure', async () => {
    const w = await world();
    const stop = Object.assign(new Error('scan stopped'), { limit: 'maxChanges', count: 7 });
    const report = await replayDecision(w.record, { ...w.deps, history: () => Promise.reject(stop) });
    expect(report.replay).to.equal('unreplayable');
    expect(report.missing).to.deep.equal([{ input: 'history-budget', key: 'maxChanges', reason: 'the replay read 7 changes, past its maxChanges' }]);
    expect(report.limits).to.include({ changes: 7, keys: 0 });

    const full = Object.assign(new Error('too many keys'), { limit: 'maxKeys', count: 3 });
    const refuse = (): never => {
      throw full;
    };
    const keys = await replayDecision(w.record, { ...w.deps, history: async (at, kinds, l, signal) => Object.assign(await w.deps.history(at, kinds, l, signal), { reserve: refuse }) });
    expect(keys.missing).to.deep.equal([{ input: 'history-budget', key: 'maxKeys', reason: 'the replay read 3 keys, past its maxKeys' }]);

    const fault = new Error('connection lost');
    expect(await replayDecision(w.record, { ...w.deps, history: () => Promise.reject(fault) }).catch((e: unknown) => e)).to.equal(fault);
  });
});
