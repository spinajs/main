import type { ChangeRecord } from '@spinajs/authz';

import type { CurrentItem, HistoryContributor, HistoryEdge, KeyState, MemoryChangeLog, ObjectRef, RelationDef, Rewrite, StoredEdge, StoredPlaceholder, StoredPolicySplicer, TupleSubjectRef } from '../../src/index.js';

export interface Tuple {
  object: ObjectRef;
  relation: string;
  subject: TupleSubjectRef;
}

export const tupleKey = (t: Tuple): string => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}${t.subject.relation === undefined ? '' : `#${t.subject.relation}`}`;

/** A tuple store serving every `tuples` relation, which logs each write at the instant it is given. */
export class TupleStore implements HistoryContributor {
  readonly kind = 'tuple' as const;
  readonly rows = new Map<string, Tuple>();

  constructor(private readonly log: MemoryChangeLog) {}

  serves(source: RelationDef['source']): boolean {
    return source.kind === 'tuples';
  }

  coverageType(): undefined {
    return undefined;
  }

  current(object: ObjectRef, relation: string): Promise<CurrentItem<TupleSubjectRef>[]> {
    const rows = [...this.rows].filter(([, t]) => t.relation === relation && t.object.type === object.type && t.object.id === object.id);
    return Promise.resolve(rows.map(([key, t]) => ({ key, image: t, subject: t.subject })));
  }

  currentReverse(subject: TupleSubjectRef, relation: string, objectType: string): Promise<CurrentItem<ObjectRef>[]> {
    const rows = [...this.rows].filter(([, t]) => t.relation === relation && t.object.type === objectType && t.subject.type === subject.type && t.subject.id === subject.id);
    return Promise.resolve(rows.map(([key, t]) => ({ key, image: t, subject: t.object })));
  }

  edges(c: ChangeRecord): HistoryEdge[] {
    const t = c.payload as Tuple | null;
    return t === null ? [] : [{ key: c.key, ...t }];
  }

  subjectAt(image: unknown): TupleSubjectRef {
    return (image as Tuple).subject;
  }

  async add(t: Tuple, at: Date): Promise<void> {
    if (this.rows.has(tupleKey(t))) return;
    this.rows.set(tupleKey(t), t);
    await this.log.append([{ kind: 'tuple', op: 'add', key: tupleKey(t), payload: t, at }]);
  }

  /** Logs the row it removes, as a DB store does: it may carry a caveat `t` does not name. */
  async remove(t: Tuple, at: Date): Promise<void> {
    const row = this.rows.get(tupleKey(t));
    if (row === undefined) return;
    this.rows.delete(tupleKey(t));
    await this.log.append([{ kind: 'tuple', op: 'remove', key: tupleKey(t), payload: row, at }]);
  }
}

interface Switch {
  store: string;
  open: boolean;
}

/**
 * Stores of switches, kind `policy`, behind `stored:abac:<store>` placeholders. A store splices as `{ intersection: [] }`
 * (everyone) when a switch of it is open at T, an opaque term per gap, and `{ priority: [] }` (no one) otherwise.
 */
export class Switches implements StoredPolicySplicer {
  readonly kind = 'policy' as const;
  readonly rows = new Map<string, Switch>();

  constructor(private readonly log: MemoryChangeLog) {}

  locate(name: string): StoredPlaceholder | undefined {
    return name.startsWith('stored:abac:') ? { model: 'abac', store: name.slice('stored:abac:'.length), permission: 'doc:edit', side: 'permit' } : undefined;
  }

  current(store: string): Promise<Array<{ key: string; image: unknown }>> {
    return Promise.resolve([...this.rows].filter(([, s]) => s.store === store).map(([key, image]) => ({ key, image })));
  }

  edge(c: ChangeRecord): StoredEdge | undefined {
    const s = (c.payload ?? c.before) as Switch | null;
    return s === null ? undefined : { store: s.store, key: c.key };
  }

  splice(_at: StoredPlaceholder, items: ReadonlyArray<{ key: string; state: KeyState }>): { term: Rewrite } {
    const gaps = items.flatMap((i): Rewrite[] => (i.state.known ? [] : [{ opaque: `switch ${i.key}` }]));
    const open = items.some((i) => i.state.known && (i.state.value as Switch | undefined)?.open === true);
    return { term: open ? { intersection: [] } : gaps.length > 0 ? { union: gaps } : { priority: [] } };
  }

  async set(key: string, s: Switch | undefined, at: Date): Promise<void> {
    const was = this.rows.get(key);
    if (s === undefined) this.rows.delete(key);
    else this.rows.set(key, s);
    const op = was === undefined ? 'add' : s === undefined ? 'remove' : 'put';
    await this.log.append([{ kind: 'policy', op, key, payload: s ?? was, before: op === 'put' ? was : undefined, at }]);
  }
}
