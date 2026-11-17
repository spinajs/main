import 'mocha';
import { expect } from 'chai';
import type { ChangeRecord } from '@spinajs/authz';

import { HistoricalTupleSource, MemoryChangeLog, ReplayHistory, TupleSourceGap } from '../../src/index.js';
import type { CurrentItem, HistoryContributor, HistoryEdge, ObjectRef, PolicyIR, RelationDef, TupleSubjectRef } from '../../src/index.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const MIN = 60_000;
const limits = { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: 6_000, afterMs: 1_000 }, now: () => T.getTime() + 60 * MIN };

const column = (c: string) => ({ kind: 'column', model: 'Doc', column: c }) as const;
const IR: PolicyIR = {
  version: 1,
  types: {
    doc: { relations: { parent_a_id: { allowed: ['folder'], source: column('a_id') }, parent_b_id: { allowed: ['space'], source: column('b_id') }, parent: { allowed: ['folder', 'space'], source: { kind: 'ancestor', via: 'orm' } } }, permissions: {} },
  },
  permissions: {},
  caveats: {},
  combine: { default: { algorithm: 'deny-overrides' } },
  principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
  opaque: [],
};

interface Image {
  model: string;
  column: string;
  new: ObjectRef | null;
}

/** Two `@Parent` columns of `Doc` under one changelog key, as the column capture logs them. */
class TwoParents implements HistoryContributor {
  readonly kind = 'column' as const;
  readonly rows = new Map<string, Record<string, ObjectRef | null>>();
  distrust: string | undefined;
  readonly calls: string[] = [];

  constructor(private readonly log: MemoryChangeLog) {}

  serves(source: RelationDef['source']): boolean {
    return source.kind === 'column' || (source.kind === 'ancestor' && source.via === 'orm');
  }

  coverageType(object: ObjectRef): string {
    return object.type;
  }

  parts(_type: string, _relation: string, source: RelationDef['source']): string[] | undefined {
    return source.kind === 'ancestor' ? ['parent_a_id', 'parent_b_id'] : undefined;
  }

  coverageGap(): Promise<string | undefined> {
    this.calls.push('coverageGap');
    return Promise.resolve(this.distrust);
  }

  current(object: ObjectRef, _relation: string, source: RelationDef['source']): Promise<CurrentItem<TupleSubjectRef>[]> {
    const target = source.kind === 'column' ? this.rows.get(object.id)?.[source.column] : undefined;
    return Promise.resolve(target ? [{ key: `doc:${object.id}#parent`, image: { model: 'Doc', column: source.kind === 'column' ? source.column : '', new: target }, subject: target }] : []);
  }

  currentReverse(): Promise<CurrentItem<ObjectRef>[]> {
    return Promise.resolve([]);
  }

  edges(c: ChangeRecord): HistoryEdge[] {
    const p = c.payload as Image & { old: ObjectRef | null };
    const object = { type: 'doc', id: c.key.slice('doc:'.length, c.key.lastIndexOf('#')) };
    return [p.old, p.new].filter((s): s is ObjectRef => s !== null).map((subject) => ({ key: c.key, object, relation: `parent_${p.column}`, subject }));
  }

  project(c: ChangeRecord, source: RelationDef['source']): ChangeRecord | undefined {
    const p = c.payload as Image & { old: ObjectRef | null };
    if (source.kind !== 'column' || p.column !== source.column) return undefined;
    const image = (target: ObjectRef | null): Image => ({ model: p.model, column: p.column, new: target });
    if (p.old === null) return { ...c, op: 'add', payload: image(p.new), before: null };
    if (p.new === null) return { ...c, op: 'remove', payload: image(p.old), before: image(p.old) };
    return { ...c, op: 'put', payload: image(p.new), before: image(p.old) };
  }

  subjectAt(image: unknown): TupleSubjectRef | undefined {
    return (image as Image).new ?? undefined;
  }

  async set(id: string, col: string, target: ObjectRef | null, at: Date): Promise<void> {
    const row = this.rows.get(id) ?? {};
    const old = row[col] ?? null;
    this.rows.set(id, { ...row, [col]: target });
    await this.log.append([{ kind: 'column', op: 'put', key: `doc:${id}#parent`, payload: { model: 'Doc', column: col, old, new: target }, at }]);
  }
}

async function world() {
  const log = new MemoryChangeLog().cover('column', ms(-60 * MIN), 'doc');
  const docs = new TwoParents(log);
  await docs.set('d1', 'a_id', { type: 'folder', id: 'f1' }, ms(-30 * MIN));
  await docs.set('d1', 'b_id', { type: 'space', id: 's1' }, ms(-20 * MIN));
  const source = async () => new HistoricalTupleSource(IR, T, [docs], await ReplayHistory.load(log, T, ['column'], limits));
  return { log, docs, source };
}

async function read(source: HistoricalTupleSource, relation: string): Promise<TupleSubjectRef[]> {
  const out: TupleSubjectRef[] = [];
  for await (const s of source.read({ type: 'doc', id: 'd1' }, relation)) out.push(s);
  return out;
}

describe('HistoricalTupleSource, contributor seams', () => {
  it('reads a relation a contributor splits into parts as their union, each column rebuilt from the shared key', async () => {
    const w = await world();
    await w.docs.set('d1', 'a_id', { type: 'folder', id: 'f2' }, ms(30 * MIN));
    const source = await w.source();
    expect(await read(source, 'parent')).to.deep.equal([
      { type: 'folder', id: 'f1' },
      { type: 'space', id: 's1' },
    ]);
    expect(source.reads).to.deep.include({ kind: 'column', key: 'doc:d1#parent', origin: 'history', seq: 3 });
  });

  it('a gap in one part keeps what the other part established', async () => {
    const w = await world();
    await w.docs.set('d1', 'b_id', { type: 'space', id: 's2' }, ms(500));
    const err = await read(await w.source(), 'parent').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(TupleSourceGap);
    expect((err as TupleSourceGap).known).to.deep.equal([{ type: 'folder', id: 'f1' }]);
    expect((err as TupleSourceGap).gaps.map((g) => g.key)).to.deep.equal(['doc:d1#parent']);
  });

  it('a coverage the contributor distrusts makes the read a gap named after the kind and type', async () => {
    const w = await world();
    w.docs.distrust = 'the stored column fingerprint of doc is not this process';
    const coveredSince = w.log.coveredSince.bind(w.log);
    w.log.coveredSince = (...a) => {
      w.docs.calls.push('coveredSince');
      return coveredSince(...a);
    };
    const err = await read(await w.source(), 'parent_a_id').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as TupleSourceGap).gaps).to.deep.equal([{ kind: 'column', key: 'column:doc', origin: 'gap', reason: 'the stored column fingerprint of doc is not this process' }]);
    expect(w.docs.calls).to.deep.equal(['coverageGap', 'coveredSince']);
  });
});
