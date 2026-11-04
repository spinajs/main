import { GLOBAL_OBJECT, GLOBAL_TYPE, IREvaluator, MemoryTupleSource } from '@spinajs/authz-ir';
import type { CaveatContext, ObjectRef, PolicyIR, PrincipalFacts, RelationName, Truth, TupleSubjectRef, TypeName } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { ACCEPT } from './graph.js';
import type { Edge } from './graph.js';

/** `object#relation@subject`; for a column relation, the column of `object`'s row pointing at `subject`. */
export interface WitnessTuple {
  readonly object: ObjectRef;
  readonly relation: RelationName;
  readonly subject: TupleSubjectRef;
}

/** Concrete authz data and one request on it: what a witness or a counterexample shows. */
export interface Scenario {
  readonly principal: PrincipalFacts;
  readonly resource: ObjectRef;
  readonly tuples: readonly WitnessTuple[];
  readonly context?: CaveatContext;
}

/** A witness the reference evaluator does not confirm: an analyzer bug, never a finding (G7). */
export class WitnessRejected extends Error {}

/** Fresh objects named by the type's initial and a counter (`invoice:i1`); `$global` is always its one object. */
class Objects {
  private readonly counters = new Map<TypeName, number>();

  fresh(type: TypeName): ObjectRef {
    if (type === GLOBAL_TYPE) return GLOBAL_OBJECT;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    return { type, id: `${/[a-z]/i.exec(type)?.[0].toLowerCase() ?? 'x'}${n}` };
  }
}

/** The minimal data that walks `edges` from a fresh resource: one tuple per letter, each to a fresh object. */
export function instantiate(resourceType: TypeName, edges: readonly Edge[]): Scenario {
  const objects = new Objects();
  const resource = objects.fresh(resourceType);
  const tuples: WitnessTuple[] = [];
  let current = resource;
  let principal: PrincipalFacts | undefined;
  for (const e of edges) {
    const l = e.letter;
    if (l === undefined) {
      if (e.to === ACCEPT) principal = { type: current.type, id: current.id };
      continue;
    }
    const caveat = l.caveat === undefined ? {} : { caveat: { name: l.caveat } };
    if (l.wildcard) {
      tuples.push({ object: current, relation: l.relation, subject: { type: l.subject, id: '*', ...caveat } });
      const p = objects.fresh(l.subject);
      principal = { type: p.type, id: p.id };
      continue;
    }
    const next = objects.fresh(l.subject);
    tuples.push({ object: current, relation: l.relation, subject: { ...next, ...(l.subjectRelation === undefined ? {} : { relation: l.subjectRelation }), ...caveat } });
    current = next;
    if (e.to === ACCEPT) principal = { type: next.type, id: next.id };
  }
  if (principal === undefined) throw new TypeError('a witness path must end in the accepting state');
  return { principal, resource, tuples };
}

/** The scenario's tuples as a `TupleSource`; tuples of column relations become columns. */
export function tupleSource(ir: PolicyIR, tuples: readonly WitnessTuple[]): MemoryTupleSource {
  const source = new MemoryTupleSource(ir);
  for (const t of tuples) {
    const rel = Object.prototype.hasOwnProperty.call(ir.types, t.object.type) ? ir.types[t.object.type].relations[t.relation] : undefined;
    if (rel?.source.kind === 'column') source.setColumn(rel.source.model, rel.source.column, t.object, { type: t.subject.type, id: t.subject.id });
    else source.add(t.object, t.relation, t.subject);
  }
  return source;
}

/** What the reference evaluator answers for each permission on the scenario; deep enough for every tuple hop. */
export async function outcome(ir: PolicyIR, s: Scenario, permissions: readonly Permission[]): Promise<Record<Permission, Truth>> {
  const evaluator = new IREvaluator(ir, tupleSource(ir, s.tuples), { maxDepth: Math.max(8, s.tuples.length + 1) });
  const out: Record<Permission, Truth> = {};
  for (const permission of permissions) out[permission] = (await evaluator.check({ principal: s.principal, permission, resource: s.resource, ...(s.context === undefined ? {} : { context: s.context }) })).truth;
  return out;
}
