import type { ChangeRecord } from '@spinajs/authz';

import type { CurrentItem, HistoryContributor, HistoryEdge, MemoryChangeLog, ObjectRef, RelationDef, TupleSubjectRef } from '../../src/index.js';

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

  async remove(t: Tuple, at: Date): Promise<void> {
    if (!this.rows.delete(tupleKey(t))) return;
    await this.log.append([{ kind: 'tuple', op: 'remove', key: tupleKey(t), payload: t, at }]);
  }
}
