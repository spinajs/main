import { parseSubjectTypeRef } from '../ir.js';
import type { ObjectRef, PolicyIR, PrincipalFacts, TupleSubjectRef, TypeName } from '../ir.js';
import { IRLimitExceeded, objectLabel, subjectLabel, subjectsOf } from './check.js';
import type { TupleSource } from './evaluator.js';

const byLabel = (a: { type: string; id: string }, b: { type: string; id: string }): number => (objectLabel(a) < objectLabel(b) ? -1 : objectLabel(a) > objectLabel(b) ? 1 : 0);

function names(ir: PolicyIR, type: TypeName): string[] {
  const t = ir.types[type];
  return t === undefined ? [] : [...new Set([...Object.keys(t.relations), ...Object.keys(t.permissions)])];
}

/**
 * Candidates for listObjects: every object of `type` reachable backwards from the principal (and its delegates)
 * through stored tuples, subject sets, column relations and the public wildcard, sorted. A relation answered by
 * `self` only is not enumerable from the principal, so objects granted only through one are not found.
 * @throws IRLimitExceeded past `maxCalls` reverse reads
 */
export async function objectCandidates(ir: PolicyIR, tuples: TupleSource, principal: PrincipalFacts, type: TypeName, maxCalls: number): Promise<ObjectRef[]> {
  const queue: TupleSubjectRef[] = [];
  for (let p: PrincipalFacts | undefined = principal; p !== undefined; p = p.onBehalfOf) queue.push({ type: p.type, id: p.id }, { type: p.type, id: '*' });
  const seen = new Set(queue.map(subjectLabel));
  const found = new Map<string, ObjectRef>();
  const reached = (o: ObjectRef): void => {
    found.set(objectLabel(o), o);
    for (const next of [{ type: o.type, id: o.id }, ...names(ir, o.type).map((r) => ({ type: o.type, id: o.id, relation: r }))]) {
      if (seen.has(subjectLabel(next))) continue;
      seen.add(subjectLabel(next));
      queue.push(next);
    }
  };
  let calls = 0;
  while (queue.length > 0) {
    const s = queue.shift()!;
    for (const [t, relation] of relationsAdmitting(ir, s)) {
      if (++calls > maxCalls) throw new IRLimitExceeded(`maxCalls ${maxCalls} exceeded listing ${type}`);
      for await (const o of tuples.reverse(s, relation, t)) if (!found.has(objectLabel(o))) reached(o);
    }
  }
  return [...found.values()].filter((o) => o.type === type).sort(byLabel);
}

/** `[type, relation]` of every stored relation whose allowed subject types admit the shape of `s`. */
function relationsAdmitting(ir: PolicyIR, s: TupleSubjectRef): Array<[TypeName, string]> {
  return Object.entries(ir.types).flatMap(([t, def]) =>
    Object.entries(def.relations)
      .filter(([, rel]) => rel.allowed.map(parseSubjectTypeRef).some((a) => a.type === s.type && a.relation === s.relation && a.wildcard === (s.id === '*')))
      .map(([relation]): [TypeName, string] => [t, relation]),
  );
}

/**
 * Candidates for listSubjects: every subject of `subjectType` (the wildcard `id: '*'` included) found forwards
 * from `object` through every relation of every object its tuples, subject sets and columns reach, sorted.
 * @throws IRLimitExceeded past `maxCalls` relation reads
 */
export async function subjectCandidates(ir: PolicyIR, tuples: TupleSource, object: ObjectRef, subjectType: TypeName, maxCalls: number): Promise<TupleSubjectRef[]> {
  const queue: ObjectRef[] = [object];
  const seen = new Set([objectLabel(object)]);
  const found = new Map<string, TupleSubjectRef>();
  let calls = 0;
  while (queue.length > 0) {
    const o = queue.shift()!;
    const def = ir.types[o.type];
    if (def === undefined) continue;
    for (const [relation, rel] of Object.entries(def.relations)) {
      if (++calls > maxCalls) throw new IRLimitExceeded(`maxCalls ${maxCalls} exceeded listing ${subjectType} subjects`);
      for (const s of await subjectsOf(tuples, o, relation, rel)) {
        if (s.type === subjectType && s.relation === undefined) found.set(objectLabel(s), { type: s.type, id: s.id });
        const next = { type: s.type, id: s.id };
        if (s.id === '*' || seen.has(objectLabel(next))) continue;
        seen.add(objectLabel(next));
        queue.push(next);
      }
    }
  }
  return [...found.values()].sort(byLabel);
}
