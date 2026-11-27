import type { PolicyIR, RelationDef, Rewrite, SubjectTypeRef } from '@spinajs/authz-ir';

/**
 * A brute-force reading of `never(holder, permission)`, written from the IR's semantics and sharing no code with the
 * engines: every set of at most `size` tuples over two objects per type is evaluated directly. Reads `tuples`
 * relations, `this`, `computed`, tuple-to-userset, union, intersection and exclusion.
 */

/** `doc:d1#viewer@user:u1`, with `user:*` for the wildcard and `group:g1#member` for a subject set. */
export interface Tuple {
  readonly object: string;
  readonly relation: string;
  readonly subject: string;
}

export const PRINCIPAL = 'user:u1';
const WILDCARD = 'user:*';
const typeOf = (id: string): string => id.slice(0, id.indexOf(':'));
const refText = (ref: SubjectTypeRef): string => (typeof ref === 'string' ? ref : ref.type);
const entries = <T>(o: Record<string, T>): Map<string, T> => new Map(Object.entries(o));
const namesPrincipal = (t: Tuple): boolean => t.subject === PRINCIPAL || t.subject === WILDCARD;

type Types = Map<string, { readonly permissions: Map<string, Rewrite>; readonly relations: Map<string, RelationDef> }>;
const compiled = new WeakMap<PolicyIR, Types>();
function typesOf(ir: PolicyIR): Types {
  const types: Types = compiled.get(ir) ?? new Map([...entries(ir.types)].map(([n, d]) => [n, { permissions: entries(d.permissions), relations: entries(d.relations) }]));
  compiled.set(ir, types);
  return types;
}

/** What taking the holder away removes: every read of `named`, the wildcards behind `wild`, every wildcard and anyone term with `all`. */
interface Cut {
  readonly named: ReadonlySet<string>;
  readonly wild: ReadonlySet<string>;
  readonly all: boolean;
}
const NO_CUT: Cut = { named: new Set(), wild: new Set(), all: false };

class Run {
  private readonly types: Types;

  constructor(ir: PolicyIR, private readonly tuples: readonly Tuple[], private readonly cut: Cut = NO_CUT) {
    this.types = typesOf(ir);
  }

  /** A node on the path answers deny, as the reference evaluator ends a cycle; a cut applies outside a subtract only. */
  node(object: string, name: string, path: ReadonlySet<string> = new Set(), pos = true, under = false): boolean {
    const key = `${object}#${name}`;
    const def = this.types.get(typeOf(object));
    if (def === undefined || path.has(key)) return false;
    const next = new Set(path).add(key);
    const rewrite = def.permissions.get(name);
    return rewrite === undefined ? this.stored(object, name, next, pos, under) : this.rewrite(object, name, rewrite, next, pos, under);
  }

  private rewrite(object: string, self: string, r: Rewrite, path: ReadonlySet<string>, pos: boolean, under: boolean): boolean {
    if ('this' in r) return this.stored(object, self, path, pos, under);
    if ('computed' in r) return this.node(object, r.computed, path, pos, under);
    if ('tupleToUserset' in r) return this.subjects(object, r.tupleToUserset.tupleset).some((s) => !s.includes('#') && s !== WILDCARD && this.node(s, r.tupleToUserset.computed, path, pos, under));
    if ('union' in r) return r.union.some((c) => this.rewrite(object, self, c, path, pos, under));
    if ('intersection' in r) return r.intersection.length === 0 ? !(pos && this.cut.all) : r.intersection.every((c) => this.rewrite(object, self, c, path, pos, under));
    if ('exclusion' in r) return this.rewrite(object, self, r.exclusion.base, path, pos, under) && !this.rewrite(object, self, r.exclusion.subtract, path, !pos, under);
    throw new Error(`the oracle does not read ${JSON.stringify(r)}`);
  }

  private stored(object: string, name: string, path: ReadonlySet<string>, pos: boolean, under: boolean): boolean {
    const here = `${typeOf(object)}#${name}`;
    if (pos && this.cut.named.has(here)) return false;
    const behind = under || (pos && this.cut.wild.has(here));
    return this.subjects(object, name).some((s) => {
      if (s === PRINCIPAL) return true;
      if (s === WILDCARD) return !(pos && (this.cut.all || behind));
      const hash = s.indexOf('#');
      return hash > 0 && this.node(s.slice(0, hash), s.slice(hash + 1), path, pos, behind);
    });
  }

  private subjects(object: string, relation: string): string[] {
    return this.tuples.filter((t) => t.object === object && t.relation === relation).map((t) => t.subject);
  }

  /** Is the principal a member of a relation in `relations`, on any object a tuple names? */
  memberOf(relations: ReadonlySet<string>): boolean {
    return this.tuples.some((t) => relations.has(`${typeOf(t.object)}#${t.relation}`) && this.stored(t.object, t.relation, new Set(), true, false));
  }
}

/** The relations a `role:<r>[@<t>]` or `<t>#<rel>` selector names. */
function named(ir: PolicyIR, selector: string): Set<string> {
  const role = /^role:([^@]+)(?:@(.+))?$/.exec(selector);
  if (role === null) return new Set([selector]);
  return new Set((entries(ir.principal.roles).get(role[1]) ?? []).filter((r) => role[2] === undefined || r.type === role[2]).map((r) => `${r.type}#${r.relation}`));
}

/** Does the principal get `<type>#<relation>` on `resource` with these tuples? */
export const allowed = (ir: PolicyIR, tuples: readonly Tuple[], resource: string, relation: string): boolean => new Run(ir, tuples).node(resource, relation);

/**
 * `narrow`: the permission is allowed, every tuple naming the principal makes it a holder by itself, and the
 * permission goes once the holder is taken away. `broad`: the first two only (another way to the permission counts).
 */
export function neverBroken(ir: PolicyIR, tuples: readonly Tuple[], resource: string, relation: string, selector: string): 'narrow' | 'broad' | undefined {
  if (!allowed(ir, tuples, resource, relation)) return undefined;
  const wildOnly = selector === 'public' || selector.startsWith('public:');
  const relations = selector === 'public' ? new Set<string>() : named(ir, wildOnly ? selector.slice('public:'.length) : selector);
  const others = tuples.filter((t) => !namesPrincipal(t));
  const holds = (t: Tuple): boolean => (!wildOnly || t.subject === WILDCARD) && (selector === 'public' || new Run(ir, [...others, t]).memberOf(relations));
  if (!tuples.every((t) => !namesPrincipal(t) || holds(t))) return undefined;
  const cut: Cut = selector === 'public' ? { ...NO_CUT, all: true } : wildOnly ? { ...NO_CUT, wild: relations } : { ...NO_CUT, named: relations };
  return new Run(ir, tuples, cut).node(resource, relation) ? 'broad' : 'narrow';
}

/** The smallest tuple sets, up to `size` tuples, that break `never(selector, <type>:<relation>)` on `<type>:<type>1` in each reading. */
export function search(ir: PolicyIR, type: string, relation: string, selectors: readonly string[], size: number): Map<string, { narrow?: Tuple[]; broad?: Tuple[] }> {
  const ids = (t: string): string[] => (t === 'user' ? [PRINCIPAL] : [`${t}:${t}1`, `${t}:${t}2`]);
  const subjects = (a: string): string[] => (a === WILDCARD ? [a] : a.includes('#') ? ids(a.slice(0, a.indexOf('#'))).map((id) => `${id}${a.slice(a.indexOf('#'))}`) : ids(a));
  const pool = [...typesOf(ir)].flatMap(([t, def]) => [...def.relations].filter(([, rel]) => rel.source.kind === 'tuples').flatMap(([r, rel]) => ids(t).flatMap((object) => rel.allowed.map(refText).flatMap(subjects).map((subject) => ({ object, relation: r, subject })))));
  const resource = `${type}:${type}1`;
  const found = new Map<string, { narrow?: Tuple[]; broad?: Tuple[] }>(selectors.map((s) => [s, {}]));
  const visit = (picked: Tuple[], rest: readonly Tuple[], left: number): void => {
    if (left > 0) return rest.forEach((t, i) => visit([...picked, t], rest.slice(i + 1), left - 1));
    if (!allowed(ir, picked, resource, relation)) return;
    for (const [selector, f] of found) {
      const got = f.narrow === undefined ? neverBroken(ir, picked, resource, relation, selector) : undefined;
      if (got === 'narrow') f.narrow = picked;
      if (got !== undefined) f.broad ??= picked;
    }
  };
  for (let n = 0; n <= size; n++) visit([], pool, n);
  return found;
}

/** A seeded policy: two or three types with two to four relations, subject sets, wildcards, tuplesets, denies and one to three roles. */
export function randomPolicy(seed: number): PolicyIR {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => {
    const x = xs.at(Math.floor(next() * xs.length));
    if (x === undefined) throw new Error('pick from an empty list');
    return x;
  };
  const types = ['a', 'b', 'c'].slice(0, next() < 0.5 ? 2 : 3);
  const rels = new Map(types.map((t) => [t, ['r0', 'r1', 'r2', 'r3'].slice(0, 2 + Math.floor(next() * 3))]));
  const relsOf = (t: string): string[] => rels.get(t) ?? [];
  const all = types.flatMap((t) => relsOf(t).map((r) => `${t}#${r}`));
  // `up` holds objects only, so it is read as a tupleset and never names a principal.
  const ups = new Map(types.filter(() => next() < 0.5).map((t) => [t, pick(types)]));
  const allowedRefs = (): string[] => {
    const out = [...(next() < 0.6 ? ['user'] : []), ...(next() < 0.35 ? ['user:*'] : []), ...(next() < 0.4 ? [pick(all)] : [])];
    return out.length === 0 ? ['user'] : out;
  };
  const leaf = (type: string): Rewrite => {
    const up = ups.get(type);
    const roll = next();
    if (up !== undefined && roll < 0.25) return { tupleToUserset: { tupleset: 'up', computed: next() < 0.3 ? 'p0' : pick(relsOf(up)) } };
    return roll > 0.95 ? { intersection: [] } : { computed: pick(relsOf(type)) };
  };
  const rewrite = (type: string, depth: number): Rewrite => {
    if (depth >= 2 || next() < 0.55) return leaf(type);
    const [x, y] = [rewrite(type, depth + 1), rewrite(type, depth + 1)];
    const op = pick(['union', 'intersection', 'exclusion']);
    return op === 'union' ? { union: [x, y] } : op === 'intersection' ? { intersection: [x, y] } : { exclusion: { base: x, subtract: y } };
  };
  const tuples = (refs: string[]): RelationDef => ({ allowed: refs, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
  const defs = types.map((t) => {
    const up = ups.get(t);
    const relations = Object.fromEntries([...relsOf(t).map((r) => [r, tuples(allowedRefs())] as const), ...(up === undefined ? [] : [['up', tuples([up])] as const])]);
    return [t, { relations, permissions: Object.fromEntries(['p0', ...(next() < 0.5 ? ['p1'] : [])].map((p) => [p, rewrite(t, 0)])) }] as const;
  });
  // Later roles often share a relation with the first one, the case a role's label hides.
  const first = [pick(all), ...(next() < 0.3 ? [pick(all)] : [])];
  const roles = ['ra', 'rb', 'rc'].slice(0, 1 + Math.floor(next() * 3)).map((r, i) => [r, [...new Set(i === 0 ? first : next() < 0.6 ? [pick(first), pick(all)] : [pick(all)])]] as const);
  const source = { origin: 'oracle' };
  return {
    version: 1,
    types: { user: { relations: {}, permissions: {} }, ...Object.fromEntries(defs) },
    permissions: Object.fromEntries(defs.flatMap(([t, d]) => Object.keys(d.permissions).map((p) => [`${t}:${p}`, { type: t, relation: p, list: false, source }]))),
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'up', roles: Object.fromEntries(roles.map(([r, keys]) => [r, keys.map((k) => ({ type: k.split('#')[0], relation: k.split('#')[1] }))])) },
    opaque: [],
  };
}
