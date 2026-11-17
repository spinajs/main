import type { ChangeRecord } from '@spinajs/authz';
import { HistoryContributors } from '@spinajs/authz-ir';
import type { CurrentItem, HistoryEdge, ObjectRef, RelationDef, RelationName, TupleSubjectRef, TypeName } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import type { TupleSubject } from './contracts.js';
import { isSubjectSet, readTuple, subjectKey } from './keys.js';
import { AUTHZ_REBAC_TUPLE_TABLE, TupleRecord, tupleOf } from './stores/db.js';

type Source = RelationDef['source'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const subjectRef = (s: TupleSubject): TupleSubjectRef => (isSubjectSet(s) ? { type: s.object.type, id: s.object.id ?? '', relation: s.relation } : { type: s.type, id: s.id });

const tupleSubject = (s: TupleSubjectRef): TupleSubject => (s.relation === undefined ? { type: s.type, id: s.id } : { object: { type: s.type, id: s.id }, relation: s.relation });

/** The tuple an image holds, or undefined when it is not one. */
function tupleIn(image: unknown): ReturnType<typeof readTuple> | undefined {
  try {
    return readTuple(image, 'replay');
  } catch {
    return undefined;
  }
}

/** A conditional tuple's caveat, carried as the image holds it: the replay treats the context it supplies as held. */
function caveatIn(image: unknown): TupleSubjectRef['caveat'] {
  const c = isRecord(image) ? image.caveat : undefined;
  if (!isRecord(c) || typeof c.name !== 'string') return undefined;
  return isRecord(c.context) ? { name: c.name, context: c.context } : { name: c.name };
}

/**
 * Rebuilds the ReBAC relations of `authz_rebac_tuple` (kind `tuple`) at a decision's instant. A change belongs to the
 * key the store logged it under (`sha256(tupleKey)`, the row's `tuple_key`), never to a tuple its payload equals: a
 * remove names the identity, and the caveat is not part of it. Current rows are read on the primary.
 */
@Singleton()
@Injectable(HistoryContributors)
export class TupleHistoryContributor extends HistoryContributors {
  readonly kind = 'tuple' as const;

  serves(source: Source): boolean {
    return source.kind === 'tuples' && source.store === AUTHZ_REBAC_TUPLE_TABLE;
  }

  coverageType(): undefined {
    return undefined;
  }

  async current(object: ObjectRef, relation: RelationName): Promise<CurrentItem<TupleSubjectRef>[]> {
    const rows = await TupleRecord.query().onPrimary().where({ namespace: object.type, object_id: object.id, relation });
    return rows.map((row) => {
      const tuple = tupleOf(row);
      return { key: row.tuple_key, image: tuple, subject: subjectRef(tuple.subject) };
    });
  }

  async currentReverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): Promise<CurrentItem<ObjectRef>[]> {
    const rows = await TupleRecord.query().onPrimary().where({ namespace: objectType, relation, subject_key: subjectKey(tupleSubject(subject)) });
    return rows.map((row) => ({ key: row.tuple_key, image: tupleOf(row), subject: { type: objectType, id: row.object_id } }));
  }

  edges(change: ChangeRecord): HistoryEdge[] {
    const t = tupleIn(change.payload) ?? tupleIn(change.before);
    return t === undefined ? [] : [{ key: change.key, object: { type: t.object.type, id: t.object.id ?? '' }, relation: t.relation, subject: subjectRef(t.subject) }];
  }

  subjectAt(image: unknown): TupleSubjectRef | undefined {
    const t = tupleIn(image);
    if (t === undefined) return undefined;
    const caveat = caveatIn(image);
    return caveat === undefined ? subjectRef(t.subject) : { ...subjectRef(t.subject), caveat };
  }
}
