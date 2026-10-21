import type { ListSupport, ModelListPlan, Permission, PrincipalRef, ResourceType } from '@spinajs/authz';

import type { TupleStore } from '../contracts.js';
import { NAME_PATTERN, objectKey, subjectKey } from '../keys.js';
import type { CompiledRewrite, NamespaceSchema } from '../namespace/compile.js';

/** The list-plan term of a ReBAC permission. */
export const REBAC_TUPLES_PLAN_OP = 'rebac.tuples';

/**
 * The row-level condition of a list plan: `tuples` holds when the row has a tuple `#relation@s` with
 * `subjectKey(s)` among `subjects`; `any` and `all` combine.
 */
export type RebacPlanExpr = { readonly tuples: { readonly relation: string; readonly subjects: readonly string[] } } | { readonly any: readonly RebacPlanExpr[] } | { readonly all: readonly RebacPlanExpr[] };

export interface RebacListPlanInput {
  readonly schema: NamespaceSchema;
  readonly store: TupleStore;
  readonly principal: PrincipalRef;
  readonly permission: Permission;
  readonly type: ResourceType;
  readonly maxDepth: number;
}

const q = (v: unknown): string => JSON.stringify(v);

/** The first exclusion a plan of type#name would have to expand, as `type#name`, or undefined. */
function exclusionIn(schema: NamespaceSchema, type: ResourceType, name: string, seen: Set<string>): string | undefined {
  const key = `${type}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const rel = schema.relation(type, name);
  if (rel) {
    for (const s of rel.sets) {
      const found = exclusionIn(schema, s.type, s.relation, seen);
      if (found) return found;
    }
    return undefined;
  }
  const rewrite = schema.permission(type, name);
  return rewrite ? exclusionInRewrite(schema, type, key, rewrite, seen) : undefined;
}

function exclusionInRewrite(schema: NamespaceSchema, type: ResourceType, key: string, r: CompiledRewrite, seen: Set<string>): string | undefined {
  switch (r.kind) {
    case 'exclusion':
      return key;
    case 'computed':
      return exclusionIn(schema, type, r.name, seen);
    case 'ttu':
      for (const t of objectTypes(schema, type, r.tupleset)) {
        const found = exclusionIn(schema, t, r.computed, seen);
        if (found) return found;
      }
      return undefined;
    default:
      for (const c of r.children) {
        const found = exclusionInRewrite(schema, type, key, c, seen);
        if (found) return found;
      }
      return undefined;
  }
}

/** The namespaces a tupleset's object subjects may have. */
function objectTypes(schema: NamespaceSchema, type: ResourceType, tupleset: string): ResourceType[] {
  return (schema.relation(type, tupleset)?.direct ?? []).filter((t) => schema.namespaces.has(t));
}

/** Whether lists of `permission` on `type` can be planned: every rewrite but exclusion. */
export function rebacListSupport(schema: NamespaceSchema, permission: Permission, type: ResourceType): ListSupport {
  const target = schema.targets.get(permission);
  if (!target || target.type !== type) return { reason: `rebac: ${permission} does not map to a relation or permission of ${type}` };
  const exclusion = exclusionIn(schema, target.type, target.name, new Set());
  if (exclusion === undefined) return true;
  return { reason: `rebac: ${permission} on ${type} reaches the exclusion of ${exclusion}, which a list plan cannot express; filter() still answers it row by row` };
}

type Ids = ReadonlySet<string>;

/**
 * Design §6.2: the rewrite of the mapped name as a condition on the row, with every subject set and
 * tuple-to-userset target expanded from the principal's side, at most maxDepth hops deep, so the plan
 * names exactly the rows a check finds a proof for within the limit.
 */
export async function rebacListPlan(input: RebacListPlanInput): Promise<ModelListPlan> {
  const { schema, store, principal, permission, type, maxDepth } = input;
  const support = rebacListSupport(schema, permission, type);
  if (support !== true) throw new Error(support.reason);
  const target = schema.targets.get(permission)!;
  const memo = new Map<string, Promise<Ids>>();

  const holders = (t: ResourceType, name: string, budget: number): Promise<Ids> => {
    const key = `${t}#${name}@${budget}`;
    let found = memo.get(key);
    if (!found) memo.set(key, (found = expand(t, name, budget)));
    return found;
  };

  const expand = async (t: ResourceType, name: string, budget: number): Promise<Ids> => {
    const rel = schema.relation(t, name);
    if (!rel) return expandRewrite(t, schema.permission(t, name)!, budget);
    const out = new Set<string>();
    if (rel.direct.includes(principal.type)) for (const r of await store.reverse(principal, name, t)) out.add(r.id!);
    if (budget < 1) return out;
    for (const s of rel.sets) {
      const members = await holders(s.type, s.relation, budget - 1);
      if (members.size === 0) continue;
      for (const r of await store.reverseMany([...members].map((id) => ({ object: { type: s.type, id }, relation: s.relation })), name, t)) out.add(r.id!);
    }
    return out;
  };

  const expandArrow = async (t: ResourceType, tupleset: string, computed: string, budget: number): Promise<Ids> => {
    const out = new Set<string>();
    if (budget < 1) return out;
    for (const x of objectTypes(schema, t, tupleset)) {
      const objects = await holders(x, computed, budget - 1);
      if (objects.size === 0) continue;
      for (const ref of await store.reverseMany([...objects].map((id) => ({ type: x, id })), tupleset, t)) out.add(ref.id!);
    }
    return out;
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

  const leaf = (relation: string, subjects: readonly string[]): RebacPlanExpr | undefined => (subjects.length === 0 ? undefined : { tuples: { relation, subjects: [...new Set(subjects)].sort() } });

  const rowName = async (name: string): Promise<RebacPlanExpr | undefined> => {
    const rel = schema.relation(type, name);
    if (!rel) return rowRewrite(schema.permission(type, name)!);
    const subjects = rel.direct.includes(principal.type) ? [subjectKey(principal)] : [];
    for (const s of rel.sets) for (const id of await holders(s.type, s.relation, maxDepth - 1)) subjects.push(subjectKey({ object: { type: s.type, id }, relation: s.relation }));
    return leaf(name, subjects);
  };

  const rowRewrite = async (r: CompiledRewrite): Promise<RebacPlanExpr | undefined> => {
    switch (r.kind) {
      case 'computed':
        return rowName(r.name);
      case 'ttu': {
        const subjects: string[] = [];
        for (const x of objectTypes(schema, type, r.tupleset)) for (const id of await holders(x, r.computed, maxDepth - 1)) subjects.push(objectKey({ type: x, id }));
        return leaf(r.tupleset, subjects);
      }
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
  return { kind: 'terms', permit: [{ op: REBAC_TUPLES_PLAN_OP, args: expr }], deny: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  if (!isRecord(t) || Object.keys(t).some((k) => k !== 'relation' && k !== 'subjects')) return fail('tuples must be { relation, subjects }');
  if (typeof t.relation !== 'string' || !NAME_PATTERN.test(t.relation)) return fail('tuples.relation must be a relation name');
  if (!Array.isArray(t.subjects) || t.subjects.some((s) => typeof s !== 'string' || s === '')) return fail('tuples.subjects must be an array of subject keys');
  return { tuples: { relation: t.relation, subjects: [...(t.subjects as string[])] } };
}
