import type { ListSupport, ModelListPlan, Permission, PrincipalRef, ResourceType } from '@spinajs/authz';

import type { Tuple, TupleCaveat, TupleStore, TupleSubject } from '../contracts.js';
import { NAME_PATTERN, caveatKey, isSubjectSet, subjectKey } from '../keys.js';
import { admitsTuple, objectTypesOf } from '../namespace/compile.js';
import type { CompiledRelation, CompiledRewrite, NamespaceSchema } from '../namespace/compile.js';
import type { CaveatTruth } from './caveats.js';

/** The list-plan term of a ReBAC permission. */
export const REBAC_TUPLES_PLAN_OP = 'rebac.tuples';

/** Tuples whose caveat has the key `caveat` (`caveatKey`), held for the request the plan was made for. */
export interface RebacPlanGroup {
  readonly caveat: string;
  readonly subjects: readonly string[];
}

/**
 * The row-level condition of a list plan: `tuples` holds when the row has an unconditional tuple `#relation@s` with
 * `subjectKey(s)` among `subjects`, or a conditional one whose caveat key and subject key are those of a `conditional`
 * group; `any` and `all` combine.
 */
export type RebacPlanExpr = { readonly tuples: { readonly relation: string; readonly subjects: readonly string[]; readonly conditional?: readonly RebacPlanGroup[] } } | { readonly any: readonly RebacPlanExpr[] } | { readonly all: readonly RebacPlanExpr[] };

export interface RebacListPlanInput {
  readonly schema: NamespaceSchema;
  readonly store: TupleStore;
  readonly principal: PrincipalRef;
  readonly permission: Permission;
  readonly type: ResourceType;
  readonly maxDepth: number;
  /** A caveat's truth for the request; without it no conditional tuple is held. */
  readonly caveat?: (c: TupleCaveat) => Promise<CaveatTruth>;
  /** The evaluation instant; a plan that evaluated a caveat is valid until it. */
  readonly now?: Date;
}

const q = (v: unknown): string => JSON.stringify(v);

/**
 * The first relation or permission `type#name` reaches through rewrites, subject sets (plain and conditional) and arrows
 * for which `test` holds, as `type#name`: `relation` is asked of every relation (a tupleset included), `rewrite` of
 * every rewrite node.
 */
export function reachFind(schema: NamespaceSchema, type: ResourceType, name: string, test: { readonly relation?: (rel: CompiledRelation, key: string) => boolean; readonly rewrite?: (r: CompiledRewrite) => boolean }): string | undefined {
  const seen = new Set<string>();
  const visit = (t: ResourceType, n: string): string | undefined => {
    const key = `${t}#${n}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const rel = schema.relation(t, n);
    if (!rel) {
      const r = schema.permission(t, n);
      return r ? inRewrite(t, key, r) : undefined;
    }
    if (test.relation?.(rel, key)) return key;
    for (const s of [...rel.sets, ...rel.conditional]) {
      const found = s.relation === undefined ? undefined : visit(s.type, s.relation);
      if (found) return found;
    }
    return undefined;
  };
  const inRewrite = (t: ResourceType, key: string, r: CompiledRewrite): string | undefined => {
    if (test.rewrite?.(r)) return key;
    switch (r.kind) {
      case 'computed':
        return visit(t, r.name);
      case 'ttu': {
        const tupleset = schema.relation(t, r.tupleset);
        if (!tupleset) return undefined;
        // An arrow follows the tupleset's object subjects only, never its subject sets.
        if (test.relation?.(tupleset, `${t}#${r.tupleset}`)) return `${t}#${r.tupleset}`;
        return firstOf(objectTypesOf(tupleset), (x) => visit(x, r.computed));
      }
      case 'exclusion':
        return inRewrite(t, key, r.base) ?? inRewrite(t, key, r.subtract);
      default:
        return firstOf(r.children, (c) => inRewrite(t, key, c));
    }
  };
  return visit(type, name);
}

function firstOf<T>(items: readonly T[], fn: (item: T) => string | undefined): string | undefined {
  for (const item of items) {
    const found = fn(item);
    if (found) return found;
  }
  return undefined;
}

/** The namespaces a tupleset's object subjects may have, with or without a caveat. */
function objectTypes(schema: NamespaceSchema, rel: CompiledRelation): ResourceType[] {
  return objectTypesOf(rel).filter((t) => schema.namespaces.has(t));
}

/** The subject sets a relation admits, with or without a caveat, each once. */
function setsOf(rel: CompiledRelation): { readonly type: ResourceType; readonly relation: string }[] {
  const out = new Map<string, { readonly type: ResourceType; readonly relation: string }>();
  for (const s of [...rel.sets, ...rel.conditional]) if (s.relation !== undefined) out.set(`${s.type}#${s.relation}`, { type: s.type, relation: s.relation });
  return [...out.values()];
}

/** Whether the relation admits a principal of `type` as a subject, with or without a caveat. */
const admitsPrincipal = (rel: CompiledRelation, type: ResourceType): boolean => rel.direct.includes(type) || rel.conditional.some((c) => c.type === type && c.relation === undefined);

/** Whether some conditional entry of the relation has the subject's shape. */
const maybeConditional = (rel: CompiledRelation, s: TupleSubject): boolean => rel.conditional.some((c) => (isSubjectSet(s) ? c.type === s.object.type && c.relation === s.relation : c.type === s.type && c.relation === undefined));

/** Whether lists of `permission` on `type` can be planned: every rewrite but exclusion. */
export function rebacListSupport(schema: NamespaceSchema, permission: Permission, type: ResourceType): ListSupport {
  const target = schema.targets.get(permission);
  if (!target || target.type !== type) return { reason: `rebac: ${permission} does not map to a relation or permission of ${type}` };
  const exclusion = reachFind(schema, target.type, target.name, { rewrite: (r) => r.kind === 'exclusion' });
  if (exclusion === undefined) return true;
  return { reason: `rebac: ${permission} on ${type} reaches the exclusion of ${exclusion}, which a list plan cannot express; filter() still answers it row by row` };
}

type Ids = ReadonlySet<string>;

/**
 * The ids of the objects of `t` whose `name` holds `principal`, expanded from the principal's side with at most
 * `budget` tuple hops: the list plan's subject sets and arrow targets, and the userset keys of an RLS session. A
 * conditional tuple is held only when `caveat` answers `allow` for it; without `caveat`, never.
 */
export function rebacHolders(schema: NamespaceSchema, store: TupleStore, principal: PrincipalRef, caveat?: (c: TupleCaveat) => Promise<CaveatTruth>): (t: ResourceType, name: string, budget: number) => Promise<Ids> {
  const memo = new Map<string, Promise<Ids>>();

  const holders = (t: ResourceType, name: string, budget: number): Promise<Ids> => {
    const key = `${t}#${name}@${budget}`;
    let found = memo.get(key);
    if (!found) memo.set(key, (found = expand(t, name, budget)));
    return found;
  };

  const held = async (rel: CompiledRelation, x: Tuple): Promise<boolean> => admitsTuple(rel, x) && (x.caveat === undefined || (caveat !== undefined && (await caveat(x.caveat)) === 'allow'));

  const objectsHolding = async (rel: CompiledRelation, subjects: readonly TupleSubject[], name: string, t: ResourceType): Promise<string[]> => {
    if (subjects.length === 0) return [];
    // A store without caveats stores only unconditional tuples of admitted shapes; reverseMany spares a store that does not override reverseTuples one read per object.
    if (!store.caveats) return (await store.reverseMany(subjects, name, t)).map((r) => r.id!);
    const out: string[] = [];
    for (const x of await store.reverseTuples(subjects, name, t)) if (await held(rel, x)) out.push(x.object.id!);
    return out;
  };

  const expand = async (t: ResourceType, name: string, budget: number): Promise<Ids> => {
    const rel = schema.relation(t, name);
    if (!rel) return expandRewrite(t, schema.permission(t, name)!, budget);
    const subjects: TupleSubject[] = admitsPrincipal(rel, principal.type) ? [principal] : [];
    if (budget >= 1) for (const s of setsOf(rel)) for (const id of await holders(s.type, s.relation, budget - 1)) subjects.push({ object: { type: s.type, id }, relation: s.relation });
    return new Set(await objectsHolding(rel, subjects, name, t));
  };

  const expandArrow = async (t: ResourceType, tupleset: string, computed: string, budget: number): Promise<Ids> => {
    const rel = schema.relation(t, tupleset);
    if (!rel || budget < 1) return new Set();
    const objects: TupleSubject[] = [];
    for (const x of objectTypes(schema, rel)) for (const id of await holders(x, computed, budget - 1)) objects.push({ type: x, id });
    return new Set(await objectsHolding(rel, objects, tupleset, t));
  };

  const expandRewrite = async (t: ResourceType, r: CompiledRewrite, budget: number): Promise<Ids> => {
    switch (r.kind) {
      case 'computed':
        return holders(t, r.name, budget);
      case 'ttu':
        return expandArrow(t, r.tupleset, r.computed, budget);
      case 'union': {
        const out = new Set<string>();
        for (const c of r.children) for (const id of await expandRewrite(t, c, budget)) out.add(id);
        return out;
      }
      case 'intersection': {
        let out: Ids | undefined;
        for (const c of r.children) {
          const ids = await expandRewrite(t, c, budget);
          out = out === undefined ? ids : new Set([...out].filter((id) => ids.has(id)));
          if (out.size === 0) break;
        }
        return out ?? new Set();
      }
      case 'exclusion':
        throw new Error(`rebac: an exclusion on ${t} cannot be planned`);
    }
  };
  return holders;
}

const byCaveat = (a: RebacPlanGroup, b: RebacPlanGroup): number => (a.caveat < b.caveat ? -1 : a.caveat > b.caveat ? 1 : 0);

/**
 * Design §6.2: the rewrite of the mapped name as a condition on the row, with every subject set and
 * tuple-to-userset target expanded from the principal's side, at most maxDepth hops deep, so the plan
 * names exactly the rows a check finds a proof for within the limit. Caveats read only the request (D4), so each
 * is evaluated once here and a leaf keeps the conditional tuples of the caveats that hold, by caveat key.
 */
export async function rebacListPlan(input: RebacListPlanInput): Promise<ModelListPlan> {
  const { schema, store, principal, permission, type, maxDepth, now } = input;
  const support = rebacListSupport(schema, permission, type);
  if (support !== true) throw new Error(support.reason);
  const target = schema.targets.get(permission)!;
  const truths = new Map<string, Promise<CaveatTruth>>();
  const evaluate = input.caveat;
  const caveat =
    evaluate &&
    ((c: TupleCaveat): Promise<CaveatTruth> => {
      const key = caveatKey(c);
      let truth = truths.get(key);
      if (!truth) truths.set(key, (truth = evaluate(c)));
      return truth;
    });
  const holders = rebacHolders(schema, store, principal, caveat);

  const groups = async (relation: string, rel: CompiledRelation, maybe: readonly TupleSubject[]): Promise<RebacPlanGroup[]> => {
    const out: RebacPlanGroup[] = [];
    if (maybe.length === 0 || caveat === undefined) return out;
    for (const cv of await store.caveatsOn(type, relation, maybe)) {
      if ((await caveat(cv)) !== 'allow') continue;
      const subjects = maybe.filter((s) => admitsTuple(rel, { subject: s, caveat: cv })).map(subjectKey);
      if (subjects.length > 0) out.push({ caveat: caveatKey(cv), subjects: [...new Set(subjects)].sort() });
    }
    return out.sort(byCaveat);
  };

  const leaf = async (relation: string, rel: CompiledRelation, candidates: readonly TupleSubject[]): Promise<RebacPlanExpr | undefined> => {
    const plain = candidates.filter((s) => admitsTuple(rel, { subject: s })).map(subjectKey);
    const conditional = await groups(
      relation,
      rel,
      candidates.filter((s) => maybeConditional(rel, s)),
    );
    if (plain.length === 0 && conditional.length === 0) return undefined;
    return { tuples: { relation, subjects: [...new Set(plain)].sort(), ...(conditional.length === 0 ? {} : { conditional }) } };
  };

  const rowName = async (name: string): Promise<RebacPlanExpr | undefined> => {
    const rel = schema.relation(type, name);
    if (!rel) return rowRewrite(schema.permission(type, name)!);
    const candidates: TupleSubject[] = admitsPrincipal(rel, principal.type) ? [principal] : [];
    for (const s of setsOf(rel)) for (const id of await holders(s.type, s.relation, maxDepth - 1)) candidates.push({ object: { type: s.type, id }, relation: s.relation });
    return leaf(name, rel, candidates);
  };

  const rowArrow = async (tupleset: string, computed: string): Promise<RebacPlanExpr | undefined> => {
    const rel = schema.relation(type, tupleset);
    if (!rel) return undefined;
    const candidates: TupleSubject[] = [];
    for (const x of objectTypes(schema, rel)) for (const id of await holders(x, computed, maxDepth - 1)) candidates.push({ type: x, id });
    return leaf(tupleset, rel, candidates);
  };

  const rowRewrite = async (r: CompiledRewrite): Promise<RebacPlanExpr | undefined> => {
    switch (r.kind) {
      case 'computed':
        return rowName(r.name);
      case 'ttu':
        return rowArrow(r.tupleset, r.computed);
      case 'union': {
        const parts: RebacPlanExpr[] = [];
        for (const c of r.children) {
          const e = await rowRewrite(c);
          if (e) parts.push(e);
        }
        return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { any: parts };
      }
      case 'intersection': {
        const parts: RebacPlanExpr[] = [];
        for (const c of r.children) {
          const e = await rowRewrite(c);
          if (!e) return undefined;
          parts.push(e);
        }
        return parts.length === 1 ? parts[0] : { all: parts };
      }
      case 'exclusion':
        throw new Error(`rebac: an exclusion on ${type} cannot be planned`);
    }
  };

  const expr = await rowName(target.name);
  if (!expr) return { kind: 'abstain' };
  // validUntil = this instant: a plan that read env is never reused (cachedPlan drops until <= instant).
  return { kind: 'terms', permit: [{ op: REBAC_TUPLES_PLAN_OP, args: expr }], deny: [], ...(truths.size > 0 && now !== undefined ? { validUntil: now } : {}) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const CAVEAT_KEY = /^[0-9a-f]{64}$/;

const isSubjectKeys = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');

function parseGroups(v: unknown, fail: (problem: string) => never): RebacPlanGroup[] {
  if (!Array.isArray(v) || v.length === 0) return fail('tuples.conditional must be a non-empty array');
  return v.map((g: unknown) => {
    if (!isRecord(g) || Object.keys(g).some((k) => k !== 'caveat' && k !== 'subjects')) return fail('tuples.conditional groups must be { caveat, subjects }');
    if (typeof g.caveat !== 'string' || !CAVEAT_KEY.test(g.caveat)) return fail('tuples.conditional caveat must be a caveat key');
    if (!isSubjectKeys(g.subjects) || g.subjects.length === 0) return fail('tuples.conditional subjects must be a non-empty array of subject keys');
    return { caveat: g.caveat, subjects: [...g.subjects] };
  });
}

/** @throws Error naming the problem, for anything but a RebacPlanExpr */
export function parseRebacPlanArgs(args: unknown): RebacPlanExpr {
  const fail = (problem: string): never => {
    throw new Error(`${REBAC_TUPLES_PLAN_OP}: ${problem}`);
  };
  if (!isRecord(args)) return fail(`args must be an object, got ${q(args)}`);
  const keys = Object.keys(args);
  if (keys.length !== 1 || !['tuples', 'any', 'all'].includes(keys[0])) return fail(`args must have exactly one of tuples, any, all; got ${q(keys)}`);
  const [key] = keys;
  if (key !== 'tuples') {
    const list = args[key];
    if (!Array.isArray(list) || list.length === 0) return fail(`${key} must be a non-empty array`);
    const parts = list.map(parseRebacPlanArgs);
    return key === 'any' ? { any: parts } : { all: parts };
  }
  const t = args.tuples;
  if (!isRecord(t) || Object.keys(t).some((k) => k !== 'relation' && k !== 'subjects' && k !== 'conditional')) return fail('tuples must be { relation, subjects, conditional? }');
  if (typeof t.relation !== 'string' || !NAME_PATTERN.test(t.relation)) return fail('tuples.relation must be a relation name');
  if (!isSubjectKeys(t.subjects)) return fail('tuples.subjects must be an array of subject keys');
  if (t.conditional === undefined) return { tuples: { relation: t.relation, subjects: [...t.subjects] } };
  return { tuples: { relation: t.relation, subjects: [...t.subjects], conditional: parseGroups(t.conditional, fail) } };
}
