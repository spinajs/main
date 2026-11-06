import type { CaveatName, ObjectRef, PolicyIR, RelationName, Rewrite, TupleSubjectRef } from '../ir.js';
import { subjectsOf } from './check.js';
import type { TupleSource } from './evaluator.js';

/** A userset rewrite expanded one level, as Zanzibar Expand: computed usersets and tuple-to-userset targets are named, not expanded. */
export type UsersetTree =
  | { kind: 'this'; object: ObjectRef; relation: RelationName; subjects: TupleSubjectRef[] }
  | { kind: 'computed'; object: ObjectRef; relation: RelationName }
  | { kind: 'tupleToUserset'; object: ObjectRef; tupleset: RelationName; computed: Array<{ object: ObjectRef; relation: RelationName }> }
  | { kind: 'union' | 'intersection'; children: UsersetTree[] }
  | { kind: 'exclusion'; base: UsersetTree; subtract: UsersetTree }
  | { kind: 'caveat'; caveat: CaveatName; child: UsersetTree }
  | { kind: 'priority'; entries: Array<{ when: UsersetTree; then: 'permit' | 'deny' }> }
  | { kind: 'opaque'; name: string };

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** @throws TypeError when `object.type` has no relation or permission `relation` */
export async function expandUserset(ir: PolicyIR, tuples: TupleSource, object: ObjectRef, relation: RelationName): Promise<UsersetTree> {
  const type = own(ir.types, object.type) ? ir.types[object.type] : undefined;
  if (type !== undefined && own(type.permissions, relation)) return expandRewrite(ir, tuples, object, relation, type.permissions[relation]);
  if (type !== undefined && own(type.relations, relation)) return expandRewrite(ir, tuples, object, relation, { this: true });
  throw new TypeError(`${object.type} has no relation ${relation}`);
}

async function expandRewrite(ir: PolicyIR, tuples: TupleSource, object: ObjectRef, self: RelationName, r: Rewrite): Promise<UsersetTree> {
  const relations = ir.types[object.type].relations;
  const each = (items: Rewrite[]): Promise<UsersetTree[]> => Promise.all(items.map((c) => expandRewrite(ir, tuples, object, self, c)));
  if ('this' in r) return { kind: 'this', object, relation: self, subjects: own(relations, self) ? await subjectsOf(tuples, object, self, relations[self]) : [] };
  if ('computed' in r) return { kind: 'computed', object, relation: r.computed };
  if ('tupleToUserset' in r) {
    const { tupleset, computed } = r.tupleToUserset;
    const targets = own(relations, tupleset) ? await subjectsOf(tuples, object, tupleset, relations[tupleset]) : [];
    return { kind: 'tupleToUserset', object, tupleset, computed: targets.filter((s) => s.relation === undefined && s.id !== '*').map((s) => ({ object: { type: s.type, id: s.id }, relation: computed })) };
  }
  if ('union' in r) return { kind: 'union', children: await each(r.union) };
  if ('intersection' in r) return { kind: 'intersection', children: await each(r.intersection) };
  if ('exclusion' in r) {
    const [base, subtract] = await each([r.exclusion.base, r.exclusion.subtract]);
    return { kind: 'exclusion', base, subtract };
  }
  if ('caveat' in r) return { kind: 'caveat', caveat: r.caveat, child: await expandRewrite(ir, tuples, object, self, r.of) };
  if ('priority' in r) {
    const whens = await each(r.priority.map((p) => p.when));
    return { kind: 'priority', entries: whens.map((when, i) => ({ when, then: r.priority[i].then })) };
  }
  return { kind: 'opaque', name: r.opaque };
}
