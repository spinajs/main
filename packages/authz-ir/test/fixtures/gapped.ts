import { TupleSourceGap } from '../../src/index.js';
import type { ObjectRef, RelationName, TupleSource, TupleSubjectRef, TypeName } from '../../src/index.js';

const label = (o: ObjectRef, relation: RelationName): string => `${o.type}:${o.id}#${relation}`;

/**
 * Wraps a source so that the reads named in `gaps` are partial: they throw `TupleSourceGap` with the subjects the inner
 * source holds, minus those `hide` names.
 */
export class GappedSource implements TupleSource {
  constructor(
    private readonly inner: TupleSource,
    private readonly gaps: ReadonlySet<string>,
    private readonly hide: (o: ObjectRef, relation: RelationName, s: TupleSubjectRef) => boolean = () => false,
  ) {}

  static key = label;

  async *read(object: ObjectRef, relation: RelationName): AsyncIterable<TupleSubjectRef> {
    const all: TupleSubjectRef[] = [];
    for await (const s of this.inner.read(object, relation)) all.push(s);
    if (!this.gaps.has(label(object, relation))) return yield* all;
    this.fail(all.filter((s) => !this.hide(object, relation, s)), label(object, relation));
  }

  reverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): AsyncIterable<ObjectRef> {
    return this.inner.reverse(subject, relation, objectType);
  }

  async column(model: string, column: string, object: ObjectRef): Promise<ObjectRef | undefined> {
    const target = await this.inner.column(model, column, object);
    if (!this.gaps.has(label(object, `${model}.${column}`))) return target;
    this.fail([], label(object, `${model}.${column}`));
  }

  private fail(known: TupleSubjectRef[], key: string): never {
    throw new TupleSourceGap(known, [{ kind: 'tuple', key, origin: 'gap', reason: `${key} is not in the history` }]);
  }
}
