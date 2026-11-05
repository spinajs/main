import { parseSubjectTypeRef } from '@spinajs/authz-ir';
import type { ObjectRef, ParsedSubjectType, PolicyIR, RelationDef, RelationName, Rewrite, TupleSubjectRef } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import type { WitnessTuple } from '../witness.js';
import type { Universe } from './universe.js';

/** A boolean formula over tuple variables and named node definitions; plain booleans are constants. */
export type Formula = boolean | { readonly var: string } | { readonly not: Formula } | { readonly and: readonly Formula[] } | { readonly or: readonly Formula[] };

export function and(...xs: Formula[]): Formula {
  if (xs.includes(false)) return false;
  const rest = xs.filter((x) => x !== true);
  return rest.length === 0 ? true : rest.length === 1 ? rest[0] : { and: rest };
}

export function or(...xs: Formula[]): Formula {
  if (xs.includes(true)) return true;
  const rest = xs.filter((x) => x !== false);
  return rest.length === 0 ? false : rest.length === 1 ? rest[0] : { or: rest };
}

export const not = (x: Formula): Formula => (typeof x === 'boolean' ? !x : 'not' in x ? x.not : { not: x });

/** A part of the IR the bounded encoding does not model; the query answers `unknown`. */
export class Unsupported extends Error {}

export interface EncodeOptions {
  /** Tuple hops a check follows, as the evaluator's `maxDepth`. */
  readonly maxDepth: number;
  /** Tuples the query rules out (`onlyVia`, `never`) are constant false. */
  readonly admit?: (t: WitnessTuple) => boolean;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const label = (o: ObjectRef): string => `${o.type}:${o.id}`;
const subjectLabel = (s: TupleSubjectRef): string => `${label(s)}${s.relation === undefined ? '' : `#${s.relation}`}`;

/**
 * The checks of a `PolicyIR` over a finite universe as boolean formulas: one variable per possible tuple, one
 * definition per (object, relation, depth). Hops go one depth deeper and stop at `maxDepth`, so recursive rewrites
 * are well-founded; a computed cycle within one depth is cut to false, as the evaluator cuts it.
 */
export class Encoder {
  /** Variable name to the tuple it stands for. */
  readonly tuples = new Map<string, WitnessTuple>();
  /** Definition name to its formula. */
  readonly defs = new Map<string, Formula>();
  /** Column relations: their variables per object, at most one of which holds. */
  readonly columns = new Map<string, string[]>();
  private readonly building = new Set<string>();

  constructor(
    readonly ir: PolicyIR,
    readonly universe: Universe,
    private readonly options: EncodeOptions,
  ) {}

  /** The principal is allowed `permission` on the resource. */
  check(permission: Permission): Formula {
    if (!own(this.ir.permissions, permission)) return false;
    const b = this.ir.permissions[permission];
    return b.type === this.universe.resource.type ? this.node(this.universe.resource, b.relation, 0) : false;
  }

  /** At-most-one constraints of column relations. */
  constraints(): Formula[] {
    const out: Formula[] = [];
    for (const vars of this.columns.values()) for (let i = 0; i < vars.length; i++) for (let j = i + 1; j < vars.length; j++) out.push(not(and({ var: vars[i] }, { var: vars[j] })));
    return out;
  }

  private tuple(object: ObjectRef, relation: RelationName, subject: TupleSubjectRef): Formula {
    const t: WitnessTuple = { object, relation, subject };
    if (this.options.admit !== undefined && !this.options.admit(t)) return false;
    const name = `t:${label(object)}#${relation}@${subjectLabel(subject)}`;
    if (!this.tuples.has(name)) {
      this.tuples.set(name, t);
      if (this.ir.types[object.type].relations[relation].source.kind === 'column') {
        const key = `${label(object)}#${relation}`;
        this.columns.set(key, [...(this.columns.get(key) ?? []), name]);
      }
    }
    return { var: name };
  }

  private node(object: ObjectRef, name: RelationName, depth: number): Formula {
    if (depth > this.options.maxDepth) return false;
    const key = `n:${label(object)}#${name}@${depth}`;
    if (this.defs.has(key)) return { var: key };
    if (this.building.has(key)) return false;
    this.building.add(key);
    try {
      const type = own(this.ir.types, object.type) ? this.ir.types[object.type] : undefined;
      let f: Formula = false;
      if (type !== undefined && own(type.permissions, name)) f = this.rewrite(object, name, type.permissions[name], depth);
      else if (type !== undefined && own(type.relations, name)) f = this.stored(object, name, depth);
      this.defs.set(key, f);
      return { var: key };
    } finally {
      this.building.delete(key);
    }
  }

  private rewrite(object: ObjectRef, self: RelationName, r: Rewrite, depth: number): Formula {
    if ('this' in r) return this.stored(object, self, depth);
    if ('computed' in r) return this.node(object, r.computed, depth);
    if ('tupleToUserset' in r) return this.arrow(object, r.tupleToUserset.tupleset, r.tupleToUserset.computed, depth);
    if ('union' in r) return or(...r.union.map((c) => this.rewrite(object, self, c, depth)));
    if ('intersection' in r) return and(...r.intersection.map((c) => this.rewrite(object, self, c, depth)));
    if ('exclusion' in r) return and(this.rewrite(object, self, r.exclusion.base, depth), not(this.rewrite(object, self, r.exclusion.subtract, depth)));
    if ('priority' in r) return this.priority(object, self, r.priority, depth);
    if ('caveat' in r) throw new Unsupported(`caveat ${r.caveat}`);
    throw new Unsupported(`opaque ${r.opaque}`);
  }

  /** First-applicable: entry i decides when its `when` holds and no earlier one does. */
  private priority(object: ObjectRef, self: RelationName, entries: ReadonlyArray<{ when: Rewrite; then: 'permit' | 'deny' }>, depth: number): Formula {
    const permits: Formula[] = [];
    const earlier: Formula[] = [];
    for (const e of entries) {
      const w = this.rewrite(object, self, e.when, depth);
      if (e.then === 'permit') permits.push(and(w, ...earlier.map(not)));
      earlier.push(w);
    }
    return or(...permits);
  }

  private stored(object: ObjectRef, name: RelationName, depth: number): Formula {
    const rel = this.ir.types[object.type].relations[name];
    if (rel === undefined) return false;
    return or(...rel.allowed.map(parseSubjectTypeRef).map((a) => this.subject(object, name, rel, a, depth)));
  }

  /** One allowed subject type of a stored relation: the principal directly, by wildcard, itself, or through a subject set. */
  private subject(object: ObjectRef, name: RelationName, rel: RelationDef, a: ParsedSubjectType, depth: number): Formula {
    const p = this.universe.principal;
    if (a.caveat !== undefined) throw new Unsupported(`caveated subject ${a.type} on ${object.type}#${name}`);
    if (rel.source.kind === 'self') return a.relation === undefined && !a.wildcard && a.type === object.type && label(object) === label(p);
    if (a.relation !== undefined) {
      if (rel.source.kind === 'column' || !own(this.ir.types, a.type)) return false;
      return or(...this.universe.objects[a.type].map((y) => and(this.tuple(object, name, { ...y, relation: a.relation }), this.node(y, a.relation!, depth + 1))));
    }
    if (a.type !== p.type || (a.wildcard && rel.source.kind === 'column')) return false;
    return this.tuple(object, name, a.wildcard ? { type: a.type, id: '*' } : p);
  }

  private arrow(object: ObjectRef, tupleset: RelationName, computed: RelationName, depth: number): Formula {
    const rel = this.ir.types[object.type].relations[tupleset];
    if (rel === undefined) return false;
    const out: Formula[] = [];
    for (const a of rel.allowed.map(parseSubjectTypeRef)) {
      if (a.relation !== undefined || a.wildcard || !own(this.ir.types, a.type)) continue;
      if (a.caveat !== undefined) throw new Unsupported(`caveated tupleset ${object.type}#${tupleset}`);
      if (rel.source.kind === 'self') {
        if (a.type === object.type) out.push(this.node(object, computed, depth + 1));
        continue;
      }
      for (const y of this.universe.objects[a.type]) out.push(and(this.tuple(object, tupleset, y), this.node(y, computed, depth + 1)));
    }
    return or(...out);
  }
}
