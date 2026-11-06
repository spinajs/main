import type { TupleSource } from '../eval/evaluator.js';
import type { ObjectRef, PolicyIR, RelationName, TupleSubjectRef, TypeName } from '../ir.js';

interface StoredTuple {
  readonly object: ObjectRef;
  readonly relation: RelationName;
  readonly subject: TupleSubjectRef;
}

const objectKey = (o: ObjectRef): string => JSON.stringify([o.type, o.id]);
const columnKey = (model: string, column: string, o: ObjectRef): string => JSON.stringify([model, column, o.type, o.id]);
const sameSubject = (a: TupleSubjectRef, b: TupleSubjectRef): boolean => a.type === b.type && a.id === b.id && a.relation === b.relation;

/**
 * A `TupleSource` in memory, for tests. Tuples serve `tuples` and `ancestor` relations, `setColumn` serves column
 * relations. Given the IR, `reverse` also answers column relations by the model and column their source names.
 */
export class MemoryTupleSource implements TupleSource {
  private readonly tuples: StoredTuple[] = [];
  private readonly columns = new Map<string, { object: ObjectRef; model: string; column: string; target: ObjectRef }>();

  constructor(private readonly ir?: PolicyIR) {}

  /** Adds `object#relation@subject`; adding a stored tuple again changes nothing. */
  add(object: ObjectRef, relation: RelationName, subject: TupleSubjectRef): this {
    if (!this.tuples.some((t) => objectKey(t.object) === objectKey(object) && t.relation === relation && sameSubject(t.subject, subject))) this.tuples.push({ object, relation, subject });
    return this;
  }

  remove(object: ObjectRef, relation: RelationName, subject: TupleSubjectRef): this {
    const i = this.tuples.findIndex((t) => objectKey(t.object) === objectKey(object) && t.relation === relation && sameSubject(t.subject, subject));
    if (i >= 0) this.tuples.splice(i, 1);
    return this;
  }

  /** Sets the column of `object`'s row to `target`; `undefined` clears it (a NULL foreign key). */
  setColumn(model: string, column: string, object: ObjectRef, target: ObjectRef | undefined): this {
    const key = columnKey(model, column, object);
    if (target === undefined) this.columns.delete(key);
    else this.columns.set(key, { object, model, column, target });
    return this;
  }

  async *read(object: ObjectRef, relation: RelationName): AsyncIterable<TupleSubjectRef> {
    for (const t of [...this.tuples]) if (t.relation === relation && objectKey(t.object) === objectKey(object)) yield await Promise.resolve(t.subject);
  }

  async *reverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): AsyncIterable<ObjectRef> {
    for (const t of [...this.tuples]) if (t.relation === relation && t.object.type === objectType && sameSubject(t.subject, subject)) yield await Promise.resolve(t.object);
    if (subject.relation === undefined) yield* this.reverseColumn(subject, relation, objectType);
  }

  private *reverseColumn(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): Iterable<ObjectRef> {
    const source = this.ir?.types[objectType]?.relations[relation]?.source;
    if (source?.kind !== 'column') return;
    for (const c of [...this.columns.values()]) if (c.model === source.model && c.column === source.column && c.object.type === objectType && objectKey(c.target) === objectKey(subject)) yield c.object;
  }

  column(model: string, column: string, object: ObjectRef): Promise<ObjectRef | undefined> {
    return Promise.resolve(this.columns.get(columnKey(model, column, object))?.target);
  }
}
