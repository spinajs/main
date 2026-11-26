import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';

import { ReplayBudgetExceeded, ReplayHistory, stateAt } from '../src/index.js';
import type { ChangePage, ChangeReader, ReplayChange } from '../src/index.js';
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
const scripted = (page: (entity: string, request: ChangePage) => readonly ReplayChange[]): ChangeReader => ({
  afterInstant: (entity, _at, request) => Promise.resolve(page(entity, request)),
  latest: () => Promise.resolve(new Map()),
  coveredSince: () => Promise.resolve(undefined),
});

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
    const readers: Record<string, ChangeReader> = {
      'ignores the cursor': scripted((entity) => [change(entity, 1), change(entity, 2)]),
      'goes back': scripted((entity, request) => (request.after === undefined ? [change(entity, 3), change(entity, 4)] : [change(entity, 2)])),
      'repeats the cursor': scripted((entity, request) => [change(entity, request.after ?? 1)]),
      'is out of order': scripted((entity, request) => (request.after === undefined ? [change(entity, 2), change(entity, 1)] : [])),
      'has no number': scripted((entity, request) => (request.after === undefined ? [change(entity, Number.NaN)] : [])),
      'holds another entity': scripted((_entity, request) => (request.after === undefined ? [change('rule', 1)] : [])),
    };
    for (const [why, reader] of Object.entries(readers)) {
      const error = await ReplayHistory.load(reader, T, ['tuple'], limits).catch((e: unknown) => e);
      expect(error, why).to.be.instanceOf(Error).and.not.to.be.instanceOf(ReplayBudgetExceeded);
      expect(error, why).to.have.property('message').that.matches(/^ReplayHistory: the reader's page of tuple/);
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
    const reader = new MemoryChangeReader(1);
    const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
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

  // P8 as a property. One key's next change is written only after its previous one committed (a row lock), so the
  // committed changes of a key are always a prefix of its changes; any key, page size and interleaving of commits
  // between pages.
  it('shows every key as a prefix of its changes after each pass, and in full once the writes stop (P8)', async () => {
    const step = fc.record({ key: fc.constantFrom('a', 'b', 'c'), commit: fc.boolean() });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), fc.array(fc.array(step, { maxLength: 4 }), { maxLength: 20 }), async (pageSize, steps) => {
        const reader = new MemoryChangeReader(pageSize);
        const written = new Map<string, number[]>();
        const open = new Map<string, PendingChange[]>();
        const write = ({ key, commit }: { key: string; commit: boolean }): void => {
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
        // Each read runs a group of writes, so a commit and the key's next write can fall between two pages of a pass.
        reader.beforeRead = () => queue.shift()?.forEach(write);
        const prefixes = (history: ReplayHistory): void => {
          for (const [key, seqs] of written) {
            const shown = history.afterFor('tuple', key).map((c) => c.seq);
            expect(shown, key).to.deep.equal(seqs.slice(0, shown.length));
          }
        };
        const history = await ReplayHistory.load(reader, T, ['tuple'], limits);
        prefixes(history);
        for (let pass = 0; pass < 3; pass++) {
          await history.catchUp();
          prefixes(history);
        }
        queue.length = 0;
        for (const pending of open.values()) reader.commit(pending);
        await history.catchUp();
        await history.catchUp();
        for (const [key, seqs] of written) expect(history.afterFor('tuple', key).map((c) => c.seq), key).to.deep.equal(seqs);
      }),
      { numRuns: 300 },
    );
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
