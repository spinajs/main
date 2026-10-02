import type { Principal, ResourceRef } from './principal.js';

export type FilterOp = 'true' | 'false' | 'and' | 'or' | 'not' | 'cmp' | 'relation' | 'under' | `native:${string}`;

// ref: 'principal.id' | 'principal.attributes.pool' | 'actor.type' | 'env.now'
//    | 'scope.<type>.<path>': attribute of the nearest ancestor of that type, e.g. 'scope.org.policies.public_links'
export type Value = string | number | boolean | null | readonly (string | number)[] | { readonly ref: string };

export type ResourceFilter =
  | { readonly op: 'true' }
  | { readonly op: 'false' }
  | { readonly op: 'and' | 'or'; readonly args: readonly ResourceFilter[] }
  | { readonly op: 'not'; readonly arg: ResourceFilter }
  // glob: segment-aware ('*' stops at '/', '**' crosses it); wildcard: '*' is any run of characters, '/' included
  | { readonly op: 'cmp'; readonly field: string; readonly cmp: 'eq' | 'ne' | 'in' | 'nin' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'glob' | 'wildcard' | 'null' | 'notnull'; readonly value?: Value }
  // the current principal holds `relation` on the row
  | { readonly op: 'relation'; readonly relation: string }
  // the row has one of these as an ancestor (or is one)
  | { readonly op: 'under'; readonly scopes: readonly ResourceRef[] }
  // compiled by a registered NativeFilter
  | { readonly op: `native:${string}`; readonly args?: unknown };

type Junction = Extract<ResourceFilter, { op: 'and' | 'or' }>;
type Negation = Extract<ResourceFilter, { op: 'not' }>;
type Comparison = Extract<ResourceFilter, { op: 'cmp' }>;
type Under = Extract<ResourceFilter, { op: 'under' }>;

export const TRUE: ResourceFilter = Object.freeze({ op: 'true' });
export const FALSE: ResourceFilter = Object.freeze({ op: 'false' });

// Only rewrites that hold in Kleene three-valued logic (SQL NULL semantics):
// no complement elimination, absorption, De Morgan or reordering.
export function simplify(f: ResourceFilter): ResourceFilter {
  switch (f.op) {
    case 'true':
      return TRUE;
    case 'false':
      return FALSE;
    case 'and':
    case 'or':
      return simplifyJunction(f as Junction);
    case 'not': {
      const arg = simplify((f as Negation).arg);
      if (arg.op === 'true') return FALSE;
      if (arg.op === 'false') return TRUE;
      if (arg.op === 'not') return (arg as Negation).arg;
      return { op: 'not', arg };
    }
    case 'cmp': {
      const { cmp, value } = f as Comparison;
      if (Array.isArray(value) && value.length === 0) {
        if (cmp === 'in') return FALSE;
        if (cmp === 'nin') return TRUE;
      }
      return f;
    }
    case 'under':
      return (f as Under).scopes.length === 0 ? FALSE : f;
    default:
      return f;
  }
}

function simplifyJunction(f: Junction): ResourceFilter {
  const [unit, zero] = f.op === 'and' ? [TRUE, FALSE] : [FALSE, TRUE];
  const args: ResourceFilter[] = [];
  const keys = new Set<string>();
  const unkeyed = new Set<ResourceFilter>();

  for (const raw of f.args) {
    const arg = simplify(raw);
    if (arg === zero) return zero;
    if (arg === unit) continue;

    for (const part of arg.op === f.op ? (arg as Junction).args : [arg]) {
      const key = canonical(part, new Set());
      if (key === undefined) {
        if (unkeyed.has(part)) continue;
        unkeyed.add(part);
      } else {
        if (keys.has(key)) continue;
        keys.add(key);
      }
      args.push(part);
    }
  }

  if (args.length === 0) return unit;
  if (args.length === 1) return args[0];
  return { op: f.op, args };
}

// JSON with sorted keys; undefined when the value has no faithful JSON form
// (cycle, BigInt, function, non-finite number, class instance), so such
// nodes dedupe by identity only.
function canonical(v: unknown, path: Set<object>): string | undefined {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : undefined;
    case 'object': {
      if (v === null) return 'null';
      if (path.has(v)) return undefined;
      path.add(v);
      try {
        if (Array.isArray(v)) {
          const items: string[] = [];
          for (const item of v) {
            const s = canonical(item, path);
            if (s === undefined) return undefined;
            items.push(s);
          }
          return `[${items.join(',')}]`;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) return undefined;
        const entries: string[] = [];
        for (const k of Object.keys(v).sort()) {
          const item = (v as Record<string, unknown>)[k];
          if (item === undefined) continue;
          const s = canonical(item, path);
          if (s === undefined) return undefined;
          entries.push(`${JSON.stringify(k)}:${s}`);
        }
        return `{${entries.join(',')}}`;
      } finally {
        path.delete(v);
      }
    }
    default:
      return undefined;
  }
}

export function and(...f: ResourceFilter[]): ResourceFilter {
  return simplify({ op: 'and', args: f });
}

export function or(...f: ResourceFilter[]): ResourceFilter {
  return simplify({ op: 'or', args: f });
}

export function not(f: ResourceFilter): ResourceFilter {
  return simplify({ op: 'not', arg: f });
}

export function bindRefs(f: ResourceFilter, scope: { principal: Principal; env: Readonly<Record<string, unknown>> }): ResourceFilter {
  return simplify(bind(f, scope, false));
}

const MISSING = Symbol('missing');
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function bind(f: ResourceFilter, scope: { principal: Principal; env: Readonly<Record<string, unknown>> }, negated: boolean): ResourceFilter {
  switch (f.op) {
    case 'and':
    case 'or':
      return { op: f.op, args: (f as Junction).args.map((x) => bind(x, scope, negated)) };
    case 'not':
      return { op: 'not', arg: bind((f as Negation).arg, scope, !negated) };
    case 'cmp': {
      const value = (f as Comparison).value;
      if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as { ref: unknown }).ref !== 'string') return f;

      const [root, ...path] = (value as { ref: string }).ref.split('.');
      if (root !== 'principal' && root !== 'env') return f;

      const bound = resolve(root === 'principal' ? scope.principal : scope.env, path);
      // Fail closed (B16): FALSE under an even number of nots, TRUE under an odd one, so a missing ref never widens access.
      if (bound === MISSING) return negated ? TRUE : FALSE;
      return { ...(f as Comparison), value: bound };
    }
    default:
      return f;
  }
}

function resolve(from: unknown, path: readonly string[]): Value | typeof MISSING {
  let v = from;
  for (const segment of path) {
    if (UNSAFE_SEGMENTS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return MISSING;
    v = (v as Record<string, unknown>)[segment];
  }

  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : MISSING;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? MISSING : v.toISOString();
  if (Array.isArray(v)) {
    // filter skips holes, so a sparse array fails the length check
    const items = v.filter((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)));
    return items.length === v.length ? items : MISSING;
  }
  return MISSING;
}
