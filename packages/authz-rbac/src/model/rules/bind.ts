import { CONDITION_UNKNOWN } from '@spinajs/authz';
import type { CompiledCondition, Condition, DecisionRequest, EvaluationContext, ParsedCondition, ResourceFilter } from '@spinajs/authz';

import { copySubject } from '../native.js';
import type { BoundCondition, BoundRule } from './args.js';
import type { CompiledRule } from './compile.js';
import { cacheSafeRef, compileCondition } from './extension.js';
import { principalSelects } from './steps.js';

/*
 * Applies a request to a config rule for a list term (args v2): what a check would decide before it
 * reads a row. Selectors other than `rank` are judged; condition leaves that read only `principal.*`,
 * `actor.*` or `env.*` become constants through the core compiler (so they mean what a check
 * computes, UNKNOWN included); such refs inside a leaf that also reads the row become literals.
 * Where a check of a row on the rule's path would fail (a `{ ref }` without a value, a condition
 * the compiler refuses), the bound rule is `indeterminate`: every row on its path is refused.
 */

const REQUEST_ROOTS = new Set(['principal', 'actor', 'env']);

export interface Binding {
  /** Undefined when the request's selectors leave the rule out. */
  readonly rule?: BoundRule;
  /** The binding read a value the decision cache key does not hold. */
  readonly unsafe: boolean;
  /** The binding holds for this request only (it read `env`, or a leaf the compiler calls uncacheable). */
  readonly perRequest: boolean;
}

interface Acc {
  unsafe: boolean;
  perRequest: boolean;
}

type RoleValue = string | { readonly ref: string } | null | undefined;

export async function bindRule(rule: CompiledRule, request: DecisionRequest, ctx: EvaluationContext): Promise<Binding> {
  const acc: Acc = { unsafe: false, perRequest: false };
  if (!principalSelects(rule, request.principal, request.actor)) return acc;
  const def = rule.def;
  const scope = def.scope.id == null ? { type: def.scope.type } : { type: def.scope.type, id: def.scope.id };
  try {
    const parts: BoundCondition[] = [];
    if (rule.subjectsWhen) parts.push(await bindCondition(rule.subjectsWhen, def.subjects!.when!, request, ctx, acc));
    if (rule.when) parts.push(await bindCondition(rule.when, def.when!, request, ctx, acc));
    const when = simplifyAll(parts);
    const resource = rule.resource ? await bindCondition(rule.resource, def.resource!, request, ctx, acc) : undefined;
    // A rule whose condition is a definite false cannot act; UNKNOWN applies it (RFC L3-1). One that reads a scope
    // stays, as the check of a row without that node or attribute faults whatever the condition is (B39).
    if (constOf(when) === false && !readsScope(rule)) return acc;
    const maxRole = roleValue(def.maxRole, rule, request, ctx, acc);
    const minRole = roleValue(def.minRole, rule, request, ctx, acc);
    const bound: BoundRule = {
      id: def.id,
      kind: def.kind,
      scope,
      ...(def.subjects?.rank ? { rank: def.subjects.rank } : {}),
      ...(when && !foldsToTrue(when) ? { when } : {}),
      ...(resource && !foldsToTrue(resource) ? { resource } : {}),
      ...(def.ladder !== undefined ? { ladder: def.ladder } : {}),
      ...(def.maxRole !== undefined ? { maxRole: maxRole as BoundRule['maxRole'] } : {}),
      ...(def.stripTags !== undefined ? { stripTags: def.stripTags } : {}),
      ...(def.assignments ? { assignments: def.assignments } : {}),
      ...(def.allow ? { allow: def.allow.map(copySubject) } : {}),
      ...(def.minRole !== undefined ? { minRole: minRole as BoundRule['minRole'] } : {}),
      ...(def.at !== undefined ? { at: def.at } : {}),
    };
    return { rule: bound, ...acc };
  } catch {
    // The check of a row on this rule's path throws the same error (model_error, a deny). Kept per principal unless it read the request.
    return { rule: { id: def.id, kind: def.kind, scope, indeterminate: true }, ...acc };
  }
}

/** @throws Error, as the check's gather does, for a `{ ref }` without a value or one that names no role */
function roleValue(v: RoleValue, rule: CompiledRule, request: DecisionRequest, ctx: EvaluationContext, acc: Acc): RoleValue {
  if (v === undefined || v === null || typeof v === 'string') return v;
  if (v.ref.startsWith('scope.')) return { ref: v.ref };
  if (!cacheSafeRef(v.ref)) acc.unsafe = true;
  if (v.ref.startsWith('env.')) acc.perRequest = true;
  const read = readRequestRef(v.ref, request, ctx);
  if (read === MISSING) throw new Error(`${rule.where}: '${v.ref}' has no value (B39: indeterminate)`);
  if (read !== null && typeof read !== 'string') throw new Error(`${rule.where}: '${v.ref}' resolves to ${JSON.stringify(read)}, which is no role`);
  return read;
}

const SWAPPED: Readonly<Record<string, string>> = { eq: 'eq', ne: 'ne', lt: 'gt', lte: 'gte', gt: 'lt', gte: 'lte' };

async function bindCondition(p: ParsedCondition, raw: Condition, request: DecisionRequest, ctx: EvaluationContext, acc: Acc): Promise<BoundCondition> {
  const node = raw as Record<string, unknown>;
  switch (p.kind) {
    case 'all':
    case 'any': {
      const items: BoundCondition[] = [];
      const list = node[p.kind] as Condition[];
      for (let i = 0; i < p.items.length; i++) items.push(await bindCondition(p.items[i], list[i], request, ctx, acc));
      return { [p.kind]: items } as BoundCondition;
    }
    case 'not':
      return { not: await bindCondition(p.item, node.not as Condition, request, ctx, acc) };
  }
  for (const ref of p.facts.refs) {
    const root = ref.split('.')[0];
    if (REQUEST_ROOTS.has(root) && !cacheSafeRef(ref)) acc.unsafe = true;
    if (root === 'env') acc.perRequest = true;
  }
  if (p.facts.roots.every((r) => REQUEST_ROOTS.has(r))) {
    const compiled = await compileCondition(p, raw, request, ctx).catch((e: unknown) => {
      // A function that throws may have read the request without naming it.
      if (p.facts.functions.length > 0) acc.unsafe = acc.perRequest = true;
      throw e;
    });
    // A function may read the request without naming it (time.between reads env.now, ip.in env.ip): the compiler says so.
    if (!compiled.cacheable) {
      acc.unsafe = true;
      acc.perRequest = true;
    }
    return { const: truth(compiled) };
  }
  if (p.kind === 'cmp') {
    if (p.operand.kind === 'literal' || !REQUEST_ROOTS.has(p.operand.ref.root)) {
      if (!REQUEST_ROOTS.has(p.attr.root)) return raw;
      // `principal.x <op> { ref: scope.* }`: the request side becomes a literal and the row side the attr.
      const swapped = SWAPPED[p.op];
      const value = readRequestRef(p.attr.text, request, ctx);
      // A literal operand beside a request attr reads only the request: bound above.
      const ref = (p.operand as Extract<typeof p.operand, { kind: 'ref' }>).ref.text;
      const read: ScopeRead = { path: ref, side: 'value' };
      // The value-side read stays beside the literal: an object there faults in the check, a list is UNKNOWN.
      return swapped !== undefined && fitsLiteral(swapped, value) ? { all: [{ attr: ref, [swapped]: value } as Condition, tautology(read)] } : unknownReading([read]);
    }
    const value = readRequestRef(p.operand.ref.text, request, ctx);
    if (fitsLiteral(p.op, value)) return { attr: p.attr.text, [p.op]: value } as Condition;
    return unknownReading(p.attr.root === 'scope' ? [{ path: p.attr.text, side: 'attr' }] : []);
  }
  // A function leaf over the row: request refs inside its args become literals; a missing one makes the leaf UNKNOWN.
  // Implicit request reads (env.now, env.ip) are UNKNOWN per row, which only narrows the list.
  let missing = false;
  const scopeReads: ScopeRead[] = [];
  const replace = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(replace);
    if (v === null || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.ref === 'string' && o.ref.startsWith('scope.')) scopeReads.push({ path: o.ref, side: 'value' });
    if (Object.keys(o).length === 1 && typeof o.ref === 'string' && REQUEST_ROOTS.has(o.ref.split('.')[0])) {
      const read = readRequestRef(o.ref, request, ctx);
      if (read === MISSING || read === null || typeof read === 'object') missing = true;
      return read;
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, replace(x)]));
  };
  const args = replace(node.args ?? {});
  return missing ? unknownReading(scopeReads) : ({ fn: node.fn, args } as Condition);
}

interface ScopeRead {
  readonly path: string;
  /** A comparison's attr side faults on a missing node or attribute; a ref (value side) also on a value that is no scalar or literal list. */
  readonly side: 'attr' | 'value';
}

/**
 * UNKNOWN on every row, but reading the leaf's scope paths as the check does, so a row without that
 * node or attribute faults (B39) in the list evaluator and in SQL, as the check does there.
 */
function unknownReading(reads: readonly ScopeRead[]): BoundCondition {
  if (reads.length === 0) return { const: null };
  return { all: [{ const: null }, ...reads.map(tautology)] };
}

/** `x OR NOT x` over a scope read: TRUE or UNKNOWN on every row, and a fault where the read faults. */
function tautology({ path, side }: ScopeRead): BoundCondition {
  const x: Condition = side === 'attr' ? { attr: path, null: false } : { attr: path, eq: { ref: path } };
  return { any: [x, { not: x }] };
}

const ROW_ROOTS = new Set(['scope', 'resource']);

/** The bound condition reads `scope.*` or `resource.*` somewhere, so folding it to a constant would drop a read. */
function readsRow(c: unknown): boolean {
  if (Array.isArray(c)) return c.some(readsRow);
  if (c === null || typeof c !== 'object') return false;
  return Object.entries(c as Record<string, unknown>).some(([k, x]) => ((k === 'attr' || k === 'ref') && typeof x === 'string' && ROW_ROOTS.has(x.split('.')[0])) || readsRow(x));
}

const foldsToTrue = (c: BoundCondition): boolean => constOf(c) === true && !readsRow(c);

/** Some condition or ref of the rule reads `scope.<type>.*`. */
function readsScope(rule: CompiledRule): boolean {
  const refs = [rule.def.maxRole, rule.def.minRole].some((v) => v !== null && typeof v === 'object' && v.ref.startsWith('scope.'));
  return refs || [rule.subjectsWhen, rule.when, rule.resource].some((c) => (c?.facts.scopeTypes.length ?? 0) > 0);
}

const UNKNOWN_FIELD = (CONDITION_UNKNOWN as Extract<ResourceFilter, { op: 'cmp' }>).field;

function truth(c: CompiledCondition): boolean | null {
  const f = c.filter;
  if (f.op === 'true') return true;
  if (f.op === 'false') return false;
  if (f.op === 'cmp' && f.field === UNKNOWN_FIELD) return null;
  // A leaf that reads only the request cannot depend on the row; anything else is treated as UNKNOWN (fail closed).
  return null;
}

const MISSING = Symbol('missing');

function readRequestRef(ref: string, request: DecisionRequest, ctx: EvaluationContext): unknown {
  const [root, ...path] = ref.split('.');
  const base = root === 'principal' ? request.principal : root === 'actor' ? request.actor ?? request.principal : { now: ctx.now, ...(request.env ?? {}) };
  let at: unknown = base;
  for (const key of path) {
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, key)) return MISSING;
    at = (at as Record<string, unknown>)[key];
  }
  return at === undefined ? MISSING : at;
}

// Values the check would compare differently (a Date, an object) become UNKNOWN: the list is then narrower, never wider.
function fitsLiteral(op: string, v: unknown): boolean {
  const scalar = (x: unknown) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));
  switch (op) {
    case 'eq':
    case 'ne':
      return scalar(v) || typeof v === 'boolean';
    case 'in':
    case 'nin':
      return Array.isArray(v) && v.every(scalar);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return scalar(v);
    case 'like':
    case 'glob':
    case 'wildcard':
      return typeof v === 'string';
    default:
      return false;
  }
}

/** The Kleene constant of a bound condition without row leaves; undefined when it reads the row. */
export function constOf(c: BoundCondition | undefined): boolean | null | undefined {
  if (c === undefined) return true;
  const n = c as Record<string, unknown>;
  if ('const' in n) return n.const as boolean | null;
  if (Array.isArray(n.all) || Array.isArray(n.any)) {
    const all = Array.isArray(n.all);
    const values = ((all ? n.all : n.any) as BoundCondition[]).map(constOf);
    if (all ? values.includes(false) : values.includes(true)) return all ? false : true;
    if (values.includes(undefined)) return undefined;
    return values.includes(null) ? null : all;
  }
  if (n.not !== undefined) {
    const v = constOf(n.not as BoundCondition);
    return v === undefined || v === null ? v : !v;
  }
  return undefined;
}

function simplifyAll(parts: readonly BoundCondition[]): BoundCondition | undefined {
  const kept = parts.filter((p) => !foldsToTrue(p));
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : { all: kept };
}
