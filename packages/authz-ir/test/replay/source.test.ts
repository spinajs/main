import 'mocha';
import { expect } from 'chai';
import { AuthzConfigError } from '@spinajs/authz';
import type { ChangeRecord } from '@spinajs/authz';

import { HistoricalTupleSource, IREvaluator, MemoryChangeLog, ReplayBudgetExceeded, ReplayHistory, TupleSourceGap } from '../../src/index.js';
import type { ChangeLogRead, CurrentItem, HistoryContributor, HistoryEdge, ObjectRef, RelationDef, TupleSubjectRef } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const MIN = 60_000;
const limits = { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: 6_000, afterMs: 1_000 } };

const user = (id: string) => ({ type: 'user', id });
const doc = (id: string) => ({ type: 'doc', id });
const folder = (id: string) => ({ type: 'folder', id });

interface Tuple {
  object: ObjectRef;
  relation: string;
  subject: TupleSubjectRef;
}
const tupleKey = (t: Tuple): string => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}`;
const editor = (u: string, d = 'd1'): Tuple => ({ object: doc(d), relation: 'editor', subject: user(u) });

/** A tuple store that logs every write unless told not to. */
class Tuples implements HistoryContributor {
  readonly kind = 'tuple' as const;
  readonly rows = new Map<string, Tuple>();
  onCurrent?: () => void;

  constructor(private readonly log: MemoryChangeLog) {}

  serves(source: RelationDef['source']): boolean {
    return source.kind === 'tuples';
  }

  coverageType(): undefined {
    return undefined;
  }

  current(object: ObjectRef, relation: string): Promise<CurrentItem<TupleSubjectRef>[]> {
    this.onCurrent?.();
    const rows = [...this.rows.entries()].filter(([, t]) => t.relation === relation && t.object.type === object.type && t.object.id === object.id);
    return Promise.resolve(rows.map(([key, t]) => ({ key, image: t, subject: t.subject })));
  }

  currentReverse(subject: TupleSubjectRef, relation: string, objectType: string): Promise<CurrentItem<ObjectRef>[]> {
    const rows = [...this.rows.entries()].filter(([, t]) => t.relation === relation && t.object.type === objectType && t.subject.type === subject.type && t.subject.id === subject.id);
    return Promise.resolve(rows.map(([key, t]) => ({ key, image: t, subject: t.object })));
  }

  edges(c: ChangeRecord): HistoryEdge[] {
    const t = c.payload as Tuple | null;
    return t === null ? [] : [{ key: c.key, ...t }];
  }

  subjectAt(image: unknown): TupleSubjectRef {
    return (image as Tuple).subject;
  }

  async add(t: Tuple, at: Date, logged = true): Promise<void> {
    this.rows.set(tupleKey(t), t);
    if (logged) await this.log.append([{ kind: 'tuple', op: 'add', key: tupleKey(t), payload: t, at }]);
  }

  async remove(t: Tuple, at: Date, logged = true): Promise<void> {
    this.rows.delete(tupleKey(t));
    if (logged) await this.log.append([{ kind: 'tuple', op: 'remove', key: tupleKey(t), payload: t, at }]);
  }
}

interface ColumnChange {
  model: string;
  column: string;
  object: ObjectRef;
  old: ObjectRef | null;
  new: ObjectRef | null;
}

/** `Doc.folder_id`, logged as `{ old, new }` the way the column capture logs it. */
class Columns implements HistoryContributor {
  readonly kind = 'column' as const;
  readonly rows = new Map<string, ObjectRef>();

  constructor(private readonly log: MemoryChangeLog) {}

  serves(source: RelationDef['source']): boolean {
    return source.kind === 'column';
  }

  coverageType(object: ObjectRef): string {
    return object.type;
  }

  current(object: ObjectRef): Promise<CurrentItem<TupleSubjectRef>[]> {
    const target = this.rows.get(`${object.type}:${object.id}`);
    return Promise.resolve(target ? [{ key: `${object.type}:${object.id}#parent`, image: target, subject: target }] : []);
  }

  currentReverse(): Promise<CurrentItem<ObjectRef>[]> {
    return Promise.resolve([]);
  }

  edges(c: ChangeRecord): HistoryEdge[] {
    const p = c.payload as ColumnChange;
    return [p.old, p.new].filter((s): s is ObjectRef => s !== null).map((subject) => ({ key: c.key, object: p.object, relation: 'parent', subject }));
  }

  project(c: ChangeRecord): ChangeRecord | undefined {
    const p = c.payload as ColumnChange;
    return p.column === 'folder_id' ? { ...c, payload: p.new ?? undefined, before: p.old ?? undefined } : undefined;
  }

  subjectAt(image: unknown): TupleSubjectRef {
    return image as ObjectRef;
  }

  async set(object: ObjectRef, target: ObjectRef | null, at: Date): Promise<void> {
    const key = `${object.type}:${object.id}`;
    const old = this.rows.get(key) ?? null;
    if (target === null) this.rows.delete(key);
    else this.rows.set(key, target);
    await this.log.append([{ kind: 'column', op: 'put', key: `${key}#parent`, payload: { model: 'Doc', column: 'folder_id', object, old, new: target }, at }]);
  }

  /** Another `@Parent` column of the doc, which shares the changelog key. */
  async other(object: ObjectRef, at: Date): Promise<void> {
    await this.log.append([{ kind: 'column', op: 'put', key: `${object.type}:${object.id}#parent`, payload: { model: 'Doc', column: 'space_id', object, old: null, new: { type: 'space', id: 's1' } }, at }]);
  }
}

async function setup() {
  const log = new MemoryChangeLog().cover('tuple', ms(-60 * MIN)).cover('column', ms(-60 * MIN), 'doc');
  const tuples = new Tuples(log);
  const columns = new Columns(log);
  await tuples.add(editor('u1'), ms(-30 * MIN));
  await tuples.add(editor('u2'), ms(-30 * MIN));
  return { log, tuples, columns };
}

async function source(log: MemoryChangeLog, contributors: HistoryContributor[], l = limits): Promise<HistoricalTupleSource> {
  return new HistoricalTupleSource(docsIR(), T, contributors, await ReplayHistory.load(log, T, ['tuple', 'column'], l));
}

async function subjects(s: HistoricalTupleSource, object: ObjectRef, relation: string): Promise<string[]> {
  const out: string[] = [];
  for await (const x of s.read(object, relation)) out.push(`${x.type}:${x.id}`);
  return out.sort();
}

async function gapOf(p: Promise<unknown>): Promise<TupleSourceGap> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TupleSourceGap) return e;
    throw e;
  }
  throw new Error('expected a TupleSourceGap');
}

describe('HistoricalTupleSource', () => {
  it('rebuilds a relation at T from current rows and the changes after T', async () => {
    const { log, tuples } = await setup();
    await tuples.add(editor('u3'), ms(30 * MIN));
    await tuples.remove(editor('u2'), ms(30 * MIN));
    await tuples.add(editor('u4'), ms(-30 * MIN));
    await tuples.remove(editor('u4'), ms(-20 * MIN));
    const s = await source(log, [tuples]);
    expect(await subjects(s, doc('d1'), 'editor')).to.deep.equal(['user:u1', 'user:u2']);
    expect(s.reads.map((r) => [r.key.split('@')[1], r.origin])).to.have.deep.members([
      ['user:u1', 'current'],
      ['user:u2', 'history'],
      ['user:u3', 'history'],
    ]);
  });

  it('feeds the evaluator, which answers unknown where a gap could decide', async () => {
    const { log, tuples } = await setup();
    await tuples.add(editor('u3'), ms(500));
    const s = await source(log, [tuples]);
    const check = (u: string) => new IREvaluator(docsIR(), s).check({ principal: user(u), permission: 'doc:update', resource: doc('d1') });
    expect((await check('u1')).truth).to.equal('allow');
    expect((await check('u3')).truth).to.equal('unknown');
    const gap = await gapOf(subjects(s, doc('d1'), 'editor'));
    expect(gap.known.map((x) => x.id).sort()).to.deep.equal(['u1', 'u2']);
    expect(gap.gaps).to.have.length(1);
    expect(gap.gaps[0]).to.deep.include({ kind: 'tuple', origin: 'gap' });
    expect(gap.message).to.match(/ambiguity window/);
  });

  it('is a gap for the whole read when the kind is not covered at T, even an empty one', async () => {
    const { log, tuples } = await setup();
    log.cover('tuple', ms(-5_000));
    const s = await source(log, [tuples]);
    expect((await gapOf(subjects(s, doc('d1'), 'editor'))).message).to.match(/history starts at/);
    expect((await gapOf(subjects(s, doc('d2'), 'editor'))).gaps[0]).to.deep.include({ kind: 'tuple', key: 'doc:d2#editor' });
  });

  it('names a relation no contributor serves', async () => {
    const { log, tuples } = await setup();
    const s = await source(log, [tuples]);
    const gap = await gapOf(s.column('Doc', 'folder_id', doc('d1')));
    expect(gap.gaps).to.deep.equal([{ key: 'doc:d1#parent', origin: 'gap', reason: 'no history contributor serves doc:d1#parent' }]);
    expect(s.reads).to.deep.include({ key: 'doc:d1#parent', origin: 'gap', reason: 'no history contributor serves doc:d1#parent' });
  });

  it('rebuilds a column through the contributor projection, with coverage per type', async () => {
    const { log, tuples, columns } = await setup();
    await columns.set(doc('d1'), folder('f1'), ms(-30 * MIN));
    await columns.set(doc('d1'), folder('f2'), ms(30 * MIN));
    await columns.set(doc('d2'), folder('f1'), ms(30 * MIN));
    const s = await source(log, [tuples, columns]);
    expect(await s.column('Doc', 'folder_id', doc('d1'))).to.deep.equal(folder('f1'));
    expect(await s.column('Doc', 'folder_id', doc('d2'))).to.equal(undefined);
    expect((await gapOf(s.column('Doc', 'folder_id', { type: 'folder', id: 'x' }))).message).to.match(/no history contributor/);
    log.cover('column', ms(-1_000), 'doc');
    expect((await gapOf(s.column('Doc', 'folder_id', doc('d1')))).message).to.match(/history starts/);
  });

  it('checks the window on a change the projection hides', async () => {
    const { log, columns } = await setup();
    await columns.set(doc('d1'), folder('f1'), ms(-30 * MIN));
    await columns.other(doc('d1'), ms(-1_000));
    const s = await source(log, [columns]);
    expect((await gapOf(s.column('Doc', 'folder_id', doc('d1')))).message).to.match(/ambiguity window/);
  });

  it('sees a removal inside the backward window of a key absent now', async () => {
    const { log, tuples } = await setup();
    await tuples.remove(editor('u2'), ms(-50));
    const s = await source(log, [tuples]);
    const gap = await gapOf(subjects(s, doc('d1'), 'editor'));
    expect(gap.message).to.match(/ambiguity window/);
    expect(gap.known.map((x) => x.id)).to.deep.equal(['u1']);
  });

  it('refuses a contributor whose kind the history did not scan', async () => {
    const { log, tuples } = await setup();
    const history = await ReplayHistory.load(log, T, ['column'], limits);
    expect(() => new HistoricalTupleSource(docsIR(), T, [tuples], history)).to.throw(AuthzConfigError, /tuple/);
  });

  it('lists in reverse an object whose column pointed at the subject at T and moved since', async () => {
    const { log, columns } = await setup();
    await columns.set(doc('d1'), folder('f1'), ms(-30 * MIN));
    await columns.set(doc('d1'), folder('f2'), ms(30 * MIN));
    const s = await source(log, [columns]);
    const out: string[] = [];
    for await (const o of s.reverse(folder('f1'), 'parent', 'doc')) out.push(o.id);
    expect(out).to.deep.equal(['d1']);
  });

  it('lists the objects a subject held at T in reverse', async () => {
    const { log, tuples } = await setup();
    await tuples.add(editor('u1', 'd2'), ms(30 * MIN));
    await tuples.add(editor('u1', 'd3'), ms(-30 * MIN));
    await tuples.remove(editor('u1', 'd3'), ms(30 * MIN));
    const s = await source(log, [tuples]);
    const out: string[] = [];
    for await (const o of s.reverse(user('u1'), 'editor', 'doc')) out.push(o.id);
    expect(out.sort()).to.deep.equal(['d1', 'd3']);
    await tuples.add(editor('u1', 'd4'), ms(0));
    expect((await gapOf((async () => { for await (const _ of s.reverse(user('u1'), 'editor', 'doc')) void _; })())).gaps).to.have.length(1);
  });

  describe('reads beside writes (3.2)', () => {
    it('sees a removal logged after the scan', async () => {
      const { log, tuples } = await setup();
      const s = await source(log, [tuples]);
      await tuples.remove(editor('u2'), ms(30 * MIN));
      expect(await subjects(s, doc('d1'), 'editor')).to.deep.equal(['user:u1', 'user:u2']);
    });

    it('finds a write the tail scan missed through the head lookup, and resolves it from history', async () => {
      const { log, tuples } = await setup();
      const s = await source(log, [tuples]);
      let pending: number[] = [];
      tuples.onCurrent = () => {
        tuples.onCurrent = undefined;
        tuples.rows.set(tupleKey(editor('u3')), editor('u3'));
        pending = log.appendPending([{ kind: 'tuple', op: 'add', key: tupleKey(editor('u3')), payload: editor('u3'), at: ms(30 * MIN) }]);
      };
      log.beforeRead = (m) => {
        if (m === 'latest' && pending.length > 0) log.commit(pending);
      };
      expect(await subjects(s, doc('d1'), 'editor')).to.deep.equal(['user:u1', 'user:u2']);
      expect(s.reads.find((r) => r.key === tupleKey(editor('u3')))).to.deep.include({ origin: 'history' });
    });

    it('is a gap when a key keeps changing during the replay', async () => {
      const { log, tuples } = await setup();
      const s = await source(log, [tuples]);
      let n = 0;
      log.beforeRead = async (m) => {
        if (m !== 'latest') return;
        const t = n++ % 2 === 0 ? tuples.remove(editor('u1'), ms(30 * MIN)) : tuples.add(editor('u1'), ms(30 * MIN));
        await t;
      };
      const gap = await gapOf(subjects(s, doc('d1'), 'editor'));
      expect(gap.gaps.map((g) => g.reason)).to.deep.equal([`tuple ${tupleKey(editor('u1'))} changed during the replay`]);
    });

    it('finds a change that committed late below the scan cursor', async () => {
      const { log, tuples } = await setup();
      const late = log.appendPending([{ kind: 'tuple', op: 'add', key: tupleKey(editor('u3')), payload: editor('u3'), at: ms(30 * MIN) }]);
      await tuples.add(editor('u5', 'd9'), ms(40 * MIN));
      const s = await source(log, [tuples]);
      tuples.rows.set(tupleKey(editor('u3')), editor('u3'));
      log.commit(late);
      const gap = await gapOf(subjects(s, doc('d1'), 'editor'));
      expect(gap.gaps[0].reason).to.match(/changed during the replay/);
      expect(gap.known.map((x) => x.id).sort()).to.deep.equal(['u1', 'u2']);
    });

    it('finds a removal of a key present at T that committed late below the scan cursor', async () => {
      const { log, tuples } = await setup();
      const late = log.appendPending([{ kind: 'tuple', op: 'remove', key: tupleKey(editor('u2')), payload: editor('u2'), at: new Date() }]);
      await tuples.add(editor('u5', 'd9'), new Date(Date.now() + 1));
      const s = await source(log, [tuples]);
      tuples.rows.delete(tupleKey(editor('u2')));
      log.commit(late);
      expect(await subjects(s, doc('d1'), 'editor')).to.deep.equal(['user:u1', 'user:u2']);
    });

    it('reads the coverage after the history it vouches for', async () => {
      const { log, tuples } = await setup();
      const s = await source(log, [tuples]);
      const order: ChangeLogRead[] = [];
      log.beforeRead = (m) => {
        order.push(m);
        if (m === 'latest') log.prune(ms(-1_000));
      };
      expect((await gapOf(subjects(s, doc('d1'), 'editor'))).message).to.match(/history starts at/);
      expect(order.at(-1)).to.equal('coveredSince');
      expect(order.indexOf('coveredSince')).to.equal(order.length - 1);
    });
  });

  it('stops past maxChanges and maxKeys', async () => {
    const { log, tuples } = await setup();
    for (let i = 0; i < 5; i++) await tuples.add(editor(`n${i}`), ms((i + 10) * MIN));
    let error: unknown;
    await ReplayHistory.load(log, T, ['tuple'], { ...limits, maxChanges: 4 }).catch((e: unknown) => (error = e));
    expect(error).to.be.instanceOf(ReplayBudgetExceeded).and.to.deep.include({ limit: 'maxChanges', count: 5 });
    const s = await source(log, [tuples], { ...limits, maxKeys: 3 });
    error = await subjects(s, doc('d1'), 'editor').catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ReplayBudgetExceeded).and.to.deep.include({ limit: 'maxKeys' });
  });

  it('stops when the signal aborts', async () => {
    const { log } = await setup();
    const error = await ReplayHistory.load(log, T, ['tuple'], limits, AbortSignal.abort()).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(Error).and.to.have.property('name', 'AbortError');
  });
});

describe('MemoryChangeLog', () => {
});
