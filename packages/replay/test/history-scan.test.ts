import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';

import { ReplayBudgetExceeded, ReplayHistory, stateAt } from '../src/index.js';
import type { ChangePage, ChangeReader, ReplayChange, ReplayHistoryLimits } from '../src/index.js';
import { MemoryChangeReader } from '../src/testing.js';
import type { ChangeRead, MemoryChange, PendingChange } from '../src/testing.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const MIN = 60_000;
// The reader's clock: an hour after T, so a change recorded "during the replay" carries an instant just before it.
const NOW = ms(60 * MIN);
const limits = { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: 6_000, afterMs: 1_000 }, now: () => NOW.getTime() };

const add = (entity: string, key: string, at: Date): MemoryChange => ({ entity, op: 'add', key, image: { key }, at });
const remove = (entity: string, key: string, at: Date): MemoryChange => ({ entity, op: 'remove', key, image: { key }, before: { key }, at });
const names = (changes: Iterable<ReplayChange>): string[] => [...changes].map((c) => `${c.entity}/${c.key}#${c.seq}`);
const many = (n: number): MemoryChange[] => Array.from({ length: n }, (_, i) => add('tuple', `k${i}`, ms((i + 1) * MIN)));

const change = (entity: string, seq: number): ReplayChange => ({ entity, key: `k${seq}`, op: 'add', image: { seq }, before: null, at: ms(MIN), seq, traceId: null });
// A reader that answers every page with `page`; `latest` and `coveredSince` are never reached by a load.
class ScriptedReader implements ChangeReader {
  constructor(private readonly page: (entity: string, request: ChangePage) => readonly ReplayChange[]) {}
  afterInstant(entity: string, _at: Date, request: ChangePage): Promise<readonly ReplayChange[]> {
    return Promise.resolve(this.page(entity, request));
  }
  latest = (): Promise<ReadonlyMap<string, ReplayChange>> => Promise.resolve(new Map());
  coveredSince = (): Promise<Date | undefined> => Promise.resolve(undefined);
}
const scripted = (page: (entity: string, request: ChangePage) => readonly ReplayChange[]): ChangeReader => new ScriptedReader(page);

const DOWN = 'the reader is down';
const refusal = (read: () => unknown): unknown => {
  try {
    read();
  } catch (e) {
    return e;
  }
  return undefined;
};

// The P8 case through its first pass: k#4 is held back, and k#2, the change before it, has not been scanned.
async function heldBack(more: Partial<ReplayHistoryLimits>, signal?: AbortSignal): Promise<{ reader: MemoryChangeReader; history: ReplayHistory }> {
  const reader = new MemoryChangeReader(1);
  const history = await ReplayHistory.load(reader, T, ['tuple'], { ...limits, ...more }, signal);
  reader.append([add('tuple', 'zero', new Date(NOW.getTime() - 4_000))]);
  // k is created in a transaction still open while the pass reads; a later seq of another key commits first.
  const created = reader.appendPending([add('tuple', 'k', new Date(NOW.getTime() - 3_000))]);
  reader.append([add('tuple', 'other', new Date(NOW.getTime() - 2_000))]);
  let pages = 0;
  reader.beforeRead = (read) => {
    if (read !== 'afterInstant' || ++pages !== 3) return;
    reader.commit(created);
    reader.append([{ entity: 'tuple', op: 'put', key: 'k', image: { key: 'k', v: 2 }, before: { key: 'k' }, at: new Date(NOW.getTime() - 1_000) }]);
  };
  // Pages of one change: zero#1, other#3 (k#2 still open), then k#4, written after k#2 committed.
  await history.catchUp();
  reader.beforeRead = undefined;
  return { reader, history };
}

type Step = { key: string; commit: boolean };
const step = fc.record({ key: fc.constantFrom('a', 'b', 'c'), commit: fc.boolean() });

// P8: one key's next change is written only after its previous one committed (a row lock), so the committed changes of
// a key are always a prefix of its changes. The reads numbered in `failing` (counted after the load) fail.
async function prefixes(pageSize: number, steps: Step[][], failing: number[]): Promise<void> {
  const reader = new MemoryChangeReader(pageSize);
  const written = new Map<string, number[]>();
  const open = new Map<string, PendingChange[]>();
  const write = ({ key, commit }: Step): void => {
    const pending = open.get(key);
    if (pending !== undefined) {
      if (commit) {
        reader.commit(pending);
        open.delete(key);
      }
      return;
    }
    const created = reader.appendPending([add('tuple', key, new Date(NOW.getTime() - 1_000))]);
    written.set(key, [...(written.get(key) ?? []), created[0].seq]);
    if (commit) reader.commit(created);
    else open.set(key, created);
  };
  const queue = [...steps];
  let reads: number | undefined;
  // Each read runs a group of writes, so a commit and the key's next write can fall between two pages of a pass.
  reader.beforeRead = () => {
    queue.shift()?.forEach(write);
    if (reads !== undefined && failing.includes(reads++)) throw new Error(DOWN);
  };
  const shown = (history: ReplayHistory): void => {
    for (const [key, seqs] of written) {
      const after = history.afterFor('tuple', key).map((c) => c.seq);
      expect(after, key).to.deep.equal(seqs.slice(0, after.length));
    }
  };
  const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
  shown(history);
  reads = 0;
  for (let pass = 0; pass < 3; pass++) {
    const failed = await history.catchUp().then(
      () => false,
      (e: unknown) => {
        if (!(e instanceof Error && e.message === DOWN)) throw e;
        return true;
      },
    );
    if (failed) expect(() => history.afterFor('tuple', 'a')).to.throw(/^ReplayHistory: the last catchUp failed/);
    else shown(history);
  }
  reads = undefined;
  queue.length = 0;
  for (const pending of open.values()) reader.commit(pending);
  await history.catchUp();
  await history.catchUp();
  for (const [key, seqs] of written) expect(history.afterFor('tuple', key).map((c) => c.seq), key).to.deep.equal(seqs);
}

// I1: each failure strikes the second pass of the P8 case while k#4 is held back.
const failures: Record<string, { maxChanges: number; arm: (reader: MemoryChangeReader, abort: AbortController) => void; error: RegExp; healed?: string[] }> = {
  // The review's probe: the abort lands on the first page, before k#2 is read; the signal stays aborted.
  'the signal aborts': {
    maxChanges: 1000,
    arm: (reader, abort) => {
      reader.beforeRead = () => abort.abort();
    },
    error: /^AbortError/,
  },
  // The third page fails after the second read k#2 new.
  'the reader fails': {
    maxChanges: 1000,
    arm: (reader) => {
      let pages = 0;
      reader.beforeRead = () => {
        if (++pages === 3) throw new Error(DOWN);
      };
    },
    error: new RegExp(DOWN),
    healed: ['tuple/k#2', 'tuple/k#4'],
  },
  // zero#1, other#3 and k#4 fill the budget; k#2 goes over it.
  'the budget stops it': { maxChanges: 3, arm: () => undefined, error: /^ReplayBudgetExceeded: maxChanges exceeded: 4$/, healed: ['tuple/k#2', 'tuple/k#4'] },
};

describe('ReplayHistory', () => {
  it('scans each entity from the backward edge of the window on, the edge included, and counts a change once per entity', async () => {
    const reader = new MemoryChangeReader().append([
      add('tuple', 'old', ms(-6_001)),
      add('tuple', 'edge', ms(-6_000)),
      add('tuple', 'late', ms(30 * MIN)),
      add('rule', 'r1', ms(MIN)),
      add('rule', 'r2', ms(2 * MIN)),
      add('policy', 'p1', ms(MIN)),
    ]);
    const history = await ReplayHistory.load(reader, T, ['tuple', 'rule'], limits);
    expect(names(history.changesOf('tuple'))).to.deep.equal(['tuple/edge#2', 'tuple/late#3']);
    // rule/r2 has the seq of tuple/edge: each entity numbers its own changes.
    expect(names(history.changesOf('rule'))).to.deep.equal(['rule/r1#1', 'rule/r2#2']);
    // policy was not asked for, so it was not read: asking the history about it is refused, never answered as "no change".
    expect(() => names(history.changesOf('policy'))).to.throw(/the policy changes were not scanned; the history was loaded for tuple, rule/);
    expect(() => history.afterFor('policy', 'p1')).to.throw(/the policy changes were not scanned/);
    expect(history.changes).to.equal(4);
    expect(names(history.afterFor('tuple', 'edge'))).to.deep.equal(['tuple/edge#2']);
    expect(history.afterFor('tuple', 'old')).to.deep.equal([]);
    expect({ at: history.at, entities: history.entities, window: history.window, precisionMs: history.precisionMs }).to.deep.equal({ at: T, entities: ['tuple', 'rule'], window: limits.window, precisionMs: 1 });
  });

  it('pages through a reader that caps its pages, until an empty page', async () => {
    const reader = new MemoryChangeReader(2).append(many(5));
    const reads: ChangeRead[] = [];
    reader.beforeRead = (read) => void reads.push(read);
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
    expect(history.changes).to.equal(5);
    expect(reads).to.deep.equal(['afterInstant', 'afterInstant', 'afterInstant', 'afterInstant']);
  });

  it('stops past maxChanges with the count it reached', async () => {
    const reader = new MemoryChangeReader().append(many(5));
    const error = await ReplayHistory.load(reader, T, ['tuple'], { ...limits, maxChanges: 4 }).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ReplayBudgetExceeded).and.to.deep.include({ limit: 'maxChanges', count: 5, name: 'ReplayBudgetExceeded', message: 'maxChanges exceeded: 5' });
  });

  it('ends a reader that never runs out of changes at maxChanges', async () => {
    const endless = scripted((entity, request) => [change(entity, (request.after ?? 0) + 1)]);
    const error = await ReplayHistory.load(endless, T, ['tuple'], { ...limits, maxChanges: 50 }).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ReplayBudgetExceeded).and.to.deep.include({ limit: 'maxChanges', count: 51 });
  });

  it('refuses a page that does not advance above its cursor, goes back, or holds another entity, instead of looping', async () => {
    const readers: Record<string, [ChangeReader, RegExp]> = {
      'ignores the cursor': [scripted((entity) => [change(entity, 1), change(entity, 2)]), /after seq 2 that holds seq 1, not above the cursor;/],
      'goes back': [scripted((entity, request) => (request.after === undefined ? [change(entity, 3), change(entity, 4)] : [change(entity, 2)])), /after seq 4 that holds seq 2, not above the cursor;/],
      'repeats the cursor': [scripted((entity, request) => [change(entity, request.after ?? 1)]), /after seq 1 that holds seq 1, not above the cursor;/],
      'is out of order': [scripted((entity, request) => (request.after === undefined ? [change(entity, 2), change(entity, 1)] : [])), /after seq none that holds seq 1, not above seq 2 before it;/],
      'has no number': [scripted((entity, request) => (request.after === undefined ? [change(entity, Number.NaN)] : [])), /after seq none that holds seq NaN, not above the cursor;/],
      'holds another entity': [scripted((_entity, request) => (request.after === undefined ? [change('rule', 1)] : [])), /after seq none that holds a change of rule;/],
      'is longer than asked': [scripted((entity, request) => Array.from({ length: request.limit + 1 }, (_, i) => change(entity, i + 1))), /after seq none that holds 10001 changes;/],
    };
    for (const [why, [reader, wrong]] of Object.entries(readers)) {
      const error = await ReplayHistory.load(reader, T, ['tuple'], limits).catch((e: unknown) => e);
      expect(error, why).to.be.instanceOf(Error).and.not.to.be.instanceOf(ReplayBudgetExceeded);
      expect(error, why).to.have.property('message').that.matches(/^ReplayHistory: ScriptedReader answered a page of tuple /).and.matches(wrong);
      expect(error, why).to.have.property('message').that.matches(/a page holds at most 10000 changes of its entity, in ascending seq above the cursor$/);
    }
  });

  it('counts keys against maxKeys before it reads their heads', async () => {
    const reader = new MemoryChangeReader().append(many(1));
    const history = await ReplayHistory.load(reader, T, ['tuple'], { ...limits, maxKeys: 2 });
    const reads: ChangeRead[] = [];
    reader.beforeRead = (read) => void reads.push(read);
    history.reserve('tuple', ['a', 'b']);
    history.reserve('tuple', ['a']);
    expect(history.keys).to.equal(2);
    const error = await (async () => history.headOf('tuple', ['c']))().catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ReplayBudgetExceeded).and.to.deep.include({ limit: 'maxKeys', count: 3 });
    expect(reads).to.deep.equal([]);
  });

  it('reads heads without an instant and befores at or before T, 500 keys a read', async () => {
    const reader = new MemoryChangeReader().append([add('tuple', 'a', ms(-30 * MIN)), remove('tuple', 'a', ms(10 * MIN)), add('tuple', 'b', ms(-20 * MIN))]);
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
    expect(names((await history.beforeOf('tuple', ['a', 'b', 'c'])).values())).to.deep.equal(['tuple/a#1', 'tuple/b#3']);
    expect(names((await history.headOf('tuple', ['a', 'b', 'c', 'a'])).values())).to.deep.equal(['tuple/a#2', 'tuple/b#3']);
    expect(history.keys).to.equal(3);
    const reads: ChangeRead[] = [];
    reader.beforeRead = (read) => void reads.push(read);
    await history.beforeOf('tuple', Array.from({ length: 501 }, (_, i) => `k${i}`));
    expect(reads).to.deep.equal(['latest', 'latest']);
  });

  it('finds on a later pass a change that committed late, within the backward side of the previous pass', async () => {
    const reader = new MemoryChangeReader();
    const late = reader.appendPending([add('tuple', 'k', new Date(NOW.getTime() - 3_000))]);
    reader.append([remove('tuple', 'k', new Date(NOW.getTime() - 1_000))]);
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
    expect(names(history.afterFor('tuple', 'k'))).to.deep.equal(['tuple/k#2']);
    reader.commit(late);
    await history.catchUp();
    expect(names(history.afterFor('tuple', 'k'))).to.deep.equal(['tuple/k#1', 'tuple/k#2']);
    expect(history.changes).to.equal(2);
  });

  // P8: a change of a key that commits between two pages of a pass is never skipped while a later change of the key is shown.
  it('holds back a change a pass read new on a later page until a pass confirms it, so a key never shows a later change without an earlier one', async () => {
    const { history } = await heldBack({});
    expect(names(history.changesOf('tuple'))).to.deep.equal(['tuple/zero#1', 'tuple/other#3', 'tuple/k#4']);
    expect(history.afterFor('tuple', 'k')).to.deep.equal([]);
    expect(names((await history.headOf('tuple', ['k'])).values())).to.deep.equal(['tuple/k#4']);
    // The next pass reads k#2 on its second page: new there too, so k#4, seen before, stays held back with it.
    await history.catchUp();
    expect(history.afterFor('tuple', 'k')).to.deep.equal([]);
    await history.catchUp();
    expect(names(history.afterFor('tuple', 'k'))).to.deep.equal(['tuple/k#2', 'tuple/k#4']);
    const state = stateAt(T, { entity: 'tuple', current: { key: 'k', v: 2 }, after: history.afterFor('tuple', 'k'), since: ms(-60 * MIN), window: limits.window });
    expect(state).to.deep.equal({ known: true, value: undefined, origin: 'history', seq: 2 });
  });

  // P8 as a property: any key, page sizes 1 to 3 and any interleaving of commits between pages.
  it('shows every key as a prefix of its changes after each pass, and in full once the writes stop (P8)', async () => {
    const steps = fc.array(fc.array(step, { maxLength: 4 }), { maxLength: 20 });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), steps, (pageSize, groups) => prefixes(pageSize, groups, [])),
      { numRuns: 300 },
    );
  });

  it('answers nothing after a pass that failed, and a prefix of every key again after the next pass that completes (P8, I1)', async () => {
    const steps = fc.array(fc.array(step, { maxLength: 4 }), { maxLength: 20 });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), steps, fc.uniqueArray(fc.nat({ max: 30 }), { maxLength: 4 }), prefixes),
      { numRuns: 300 },
    );
  });

  for (const [how, { maxChanges, arm, error, healed }] of Object.entries(failures)) {
    it(`answers nothing after a pass that fails part-way because ${how}, never a change without the one before it (I1)`, async () => {
      const abort = new AbortController();
      const { reader, history } = await heldBack({ maxChanges }, abort.signal);
      arm(reader, abort);
      const failure = await history.catchUp().catch((e: unknown) => e);
      expect(String(failure)).to.match(error);
      const reads: Record<string, () => unknown> = {
        afterFor: () => history.afterFor('tuple', 'k'),
        changesOf: () => [...history.changesOf('tuple')],
        headOf: () => history.headOf('tuple', ['k']),
        beforeOf: () => history.beforeOf('tuple', ['k']),
        reserve: () => history.reserve('tuple', ['k']),
        since: () => history.since('tuple'),
      };
      for (const [read, call] of Object.entries(reads)) {
        const refused = refusal(call);
        expect(refused, read).to.be.instanceOf(Error).and.not.to.be.instanceOf(ReplayBudgetExceeded);
        expect(refused, read).to.include({ cause: failure }).and.not.to.have.property('limit');
        expect(refused, read).not.to.have.property('count');
        expect(refused, read).to.have.property('message').that.matches(/^ReplayHistory: the last catchUp failed, so a key could show a change without the one before it;/);
      }
      reader.beforeRead = undefined;
      if (healed === undefined) {
        expect(String(await history.catchUp().catch((e: unknown) => e))).to.match(error);
        expect(() => history.afterFor('tuple', 'k')).to.throw(/the last catchUp failed/);
      } else {
        await history.catchUp();
        expect(names(history.afterFor('tuple', 'k'))).to.deep.equal(healed);
      }
    });
  }

  it('starts the pass after a failed one where the last completed pass started, so it reads what the failed one skipped', async () => {
    let now = NOW.getTime();
    const reader = new MemoryChangeReader();
    const history = await ReplayHistory.load(reader, T, ['tuple'], { ...limits, now: () => now });
    reader.commit(reader.appendPending([add('tuple', 'k', new Date(now + 1_000))]));
    // Had the failed pass counted, the next one would start after k#1.
    now += 60_000;
    reader.beforeRead = () => {
      throw new Error(DOWN);
    };
    expect(String(await history.catchUp().catch((e: unknown) => e))).to.match(new RegExp(DOWN));
    reader.beforeRead = undefined;
    await history.catchUp();
    expect(names(history.afterFor('tuple', 'k'))).to.deep.equal(['tuple/k#1']);
  });

  it('refuses a second catchUp, and every read, while a pass runs', async () => {
    const reader = new MemoryChangeReader().append(many(2));
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
    const during: unknown[] = [];
    reader.beforeRead = () => {
      reader.beforeRead = undefined;
      during.push(refusal(() => history.afterFor('tuple', 'k0')));
    };
    const pass = history.catchUp();
    const second = await history.catchUp().catch((e: unknown) => e);
    await pass;
    for (const refused of [second, ...during]) expect(refused).to.have.property('message').that.matches(/^ReplayHistory: a catchUp is running; await it/);
    expect(during).to.have.length(1);
    expect(names(history.afterFor('tuple', 'k0'))).to.deep.equal(['tuple/k0#1']);
  });

  it('refuses a limit that is not a finite number in its range, naming it, before it reads', async () => {
    const window = limits.window;
    const bad: [string, Partial<ReplayHistoryLimits>][] = [
      ...[Number.NaN, Infinity, -1, 2.5].flatMap((v): [string, Partial<ReplayHistoryLimits>][] => [
        ['maxChanges', { maxChanges: v }],
        ['maxKeys', { maxKeys: v }],
      ]),
      ...[Number.NaN, Infinity, -1].flatMap((v): [string, Partial<ReplayHistoryLimits>][] => [
        ['window.beforeMs', { window: { ...window, beforeMs: v } }],
        ['window.afterMs', { window: { ...window, afterMs: v } }],
      ]),
      ...[Number.NaN, Infinity, -1, 0].map((v): [string, Partial<ReplayHistoryLimits>] => ['precisionMs', { precisionMs: v }]),
      ...[Number.NaN, Infinity].map((v): [string, Partial<ReplayHistoryLimits>] => ['now', { now: () => v }]),
    ];
    for (const [i, [member, wrong]] of bad.entries()) {
      const reads: ChangeRead[] = [];
      const reader = new MemoryChangeReader();
      reader.beforeRead = (read) => void reads.push(read);
      const error = await ReplayHistory.load(reader, T, ['tuple'], { ...limits, ...wrong }).catch((e: unknown) => e);
      expect(error, `${i}`).to.be.instanceOf(RangeError).and.to.have.property('message').that.satisfies((message: string) => message.startsWith(`ReplayHistory: ${member} must be `));
      expect(reads, `${i}`).to.deep.equal([]);
    }
    expect(await ReplayHistory.load(new MemoryChangeReader(), new Date(Number.NaN), ['tuple'], limits).catch((e: unknown) => e)).to.be.instanceOf(RangeError).with.property('message').that.matches(/^ReplayHistory: at must be /);
    // Zero is a budget and a window: the scan runs, and its first change stops it.
    const zero = await ReplayHistory.load(new MemoryChangeReader().append(many(1)), T, ['tuple'], { ...limits, maxChanges: 0, maxKeys: 0, window: { beforeMs: 0, afterMs: 0 } }).catch((e: unknown) => e);
    expect(zero).to.be.instanceOf(ReplayBudgetExceeded).and.to.deep.include({ limit: 'maxChanges', count: 1 });
  });

  it('leaves a late commit with an older instant to headOf', async () => {
    const reader = new MemoryChangeReader();
    const late = reader.appendPending([add('tuple', 'k', ms(30 * MIN))]);
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
    reader.commit(late);
    await history.catchUp();
    expect(history.afterFor('tuple', 'k')).to.deep.equal([]);
    expect(names((await history.headOf('tuple', ['k'])).values())).to.deep.equal(['tuple/k#1']);
  });

  it('reads coverage every time it is asked, never from memory', async () => {
    const reader = new MemoryChangeReader().cover('tuple', ms(-60 * MIN));
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
    expect(await history.since('tuple')).to.deep.equal(ms(-60 * MIN));
    reader.prune(ms(-1_000));
    expect(await history.since('tuple')).to.deep.equal(ms(-1_000));
    expect(await history.since('rule')).to.equal(undefined);
  });

  it('stops when the signal aborts', async () => {
    const error = await ReplayHistory.load(new MemoryChangeReader(), T, ['tuple'], limits, AbortSignal.abort()).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(Error).and.to.have.property('name', 'AbortError');
  });
});
