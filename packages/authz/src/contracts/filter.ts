import type { Principal, ResourceRef } from './principal.js';

export type FilterOp = 'true' | 'false' | 'and' | 'or' | 'not' | 'cmp' | 'relation' | 'under' | `native:${string}`;

/** The non-native ops every model may use. */
export const CORE_FILTER_OPS: readonly FilterOp[] = Object.freeze(['true', 'false', 'and', 'or', 'not', 'relation', 'under', 'cmp'] as const);

// ref: 'principal.id' | 'principal.attributes.pool' | 'actor.type' | 'env.now'
//    | 'scope.<type>.<path>': attribute of the nearest ancestor of that type, e.g. 'scope.org.policies.public_links'
export type Value = string | number | boolean | null | readonly (string | number)[] | { readonly ref: string };

export type ResourceFilter =
  | { readonly op: 'true' }
  | { readonly op: 'false' }
  | { readonly op: 'and' | 'or'; readonly args: readonly ResourceFilter[] }
  | { readonly op: 'not'; readonly arg: ResourceFilter }
  // glob: segment-aware ('*' stops at '/', '**' crosses it); wildcard: '*' is any run of characters, '/' included
  // eq/ne/in/nin with a literal null never match (UNKNOWN); null tests are cmp 'null'/'notnull', so never compile `eq null` to IS NULL
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

// Frozen nodes this module built in simplified form; constructors that grow
// a tree call by call skip the parts already simplified.
const SIMPLIFIED = new WeakSet<object>();

// Only rewrites that hold in Kleene three-valued logic (SQL NULL semantics):
// no complement elimination, absorption, De Morgan or reordering.
export function simplify(f: ResourceFilter): ResourceFilter {
  if (SIMPLIFIED.has(f)) return f;

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
      return built({ op: 'not', arg });
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

function built(f: ResourceFilter): ResourceFilter {
  Object.freeze(f);
  SIMPLIFIED.add(f);
  return f;
}

function simplifyJunction(f: Junction): ResourceFilter {
  const [unit, zero] = f.op === 'and' ? [TRUE, FALSE] : [FALSE, TRUE];
  const args: ResourceFilter[] = [];
  const buckets = new Map<number, ResourceFilter[]>();
  const unkeyed = new Set<ResourceFilter>();

  for (const raw of f.args) {
    const arg = simplify(raw);
    if (arg === zero) return zero;
    if (arg === unit) continue;

    for (const part of arg.op === f.op ? (arg as Junction).args : [arg]) {
      const hash = hashOverride ? hashOverride(part) : nodeHash(part);
      if (hash === null) {
        if (unkeyed.has(part)) continue;
        unkeyed.add(part);
      } else {
        const bucket = buckets.get(hash);
        if (bucket === undefined) buckets.set(hash, [part]);
        else if (bucket.some((x) => sameNode(x, part))) continue;
        else bucket.push(part);
      }
      args.push(part);
    }
  }

  if (args.length === 0) return unit;
  if (args.length === 1) return args[0];
  return built({ op: f.op, args: Object.freeze(args) });
}

// Structural equality is JSON with sorted keys, undefined properties left
// out. A value with no faithful JSON form (cycle, BigInt, function,
// non-finite number, class instance, throwing getter or proxy) gets a null
// hash and dedupes by identity only. Hashes are computed once per node,
// bottom-up; equal hashes are confirmed by sameNode. The per-process seed
// keeps collisions from being planned offline.
let HASHES = new WeakMap<object, number | null>();
const randomSeed = (): number => (globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 2 ** 32)) >>> 0;
let seed = randomSeed();
let hashOverride: ((f: ResourceFilter) => number | null) | undefined;

const basis = (): number => (0x811c9dc5 ^ seed) >>> 0;
const mix = (h: number, x: number): number => Math.imul(h ^ x, 0x01000193) >>> 0;

function mixString(h: number, s: string): number {
  h = mix(h, s.length);
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return h;
}

function nodeHash(f: ResourceFilter): number | null {
  let hash = HASHES.get(f);
  if (hash !== undefined) return hash;

  try {
    if (f.op === 'and' || f.op === 'or') {
      hash = mixString(basis(), f.op);
      for (const arg of (f as Junction).args) {
        const h = nodeHash(arg);
        if (h === null) {
          hash = null;
          break;
        }
        hash = mix(hash, h);
      }
    } else if (f.op === 'not') {
      const h = nodeHash((f as Negation).arg);
      hash = h === null ? null : mix(mixString(basis(), 'not'), h);
    } else {
      hash = valueHash(f, basis(), new Set());
    }
  } catch {
    hash = null;
  }

  HASHES.set(f, hash);
  return hash;
}

function valueHash(v: unknown, h: number, path: Set<object>): number | null {
  switch (typeof v) {
    case 'string':
      return mixString(mix(h, 1), v);
    case 'number':
      return Number.isFinite(v) ? mixString(mix(h, 2), String(v)) : null;
    case 'boolean':
      return mix(h, v ? 3 : 4);
    case 'object': {
      if (v === null) return mix(h, 5);
      if (path.has(v)) return null;
      path.add(v);
      try {
        if (Array.isArray(v)) {
          let out: number | null = mix(mix(h, 6), v.length);
          for (let i = 0; i < v.length && out !== null; i++) out = v[i] === undefined ? null : valueHash(v[i], out, path);
          return out;
        }
        if (!isPlain(v)) return null;
        let out: number | null = mix(h, 7);
        for (const k of Object.keys(v).sort()) {
          const item = (v as Record<string, unknown>)[k];
          if (item === undefined) continue;
          out = valueHash(item, mixString(out, k), path);
          if (out === null) return null;
        }
        return out;
      } finally {
        path.delete(v);
      }
    }
    default:
      return null;
  }
}

function sameNode(x: ResourceFilter, y: ResourceFilter): boolean {
  if (x === y) return true;
  if (x.op !== y.op) return false;
  try {
    if (x.op === 'and' || x.op === 'or') {
      const xs = (x as Junction).args;
      const ys = (y as Junction).args;
      return xs.length === ys.length && xs.every((a, i) => sameNode(a, ys[i]));
    }
    if (x.op === 'not') return sameNode((x as Negation).arg, (y as Negation).arg);
    return sameValue(x, y);
  } catch {
    return false;
  }
}

function sameValue(x: unknown, y: unknown): boolean {
  if (typeof x !== typeof y) return false;
  switch (typeof x) {
    case 'string':
    case 'boolean':
      return x === y;
    case 'number':
      return Number.isFinite(x) && x === y;
    case 'object': {
      if (x === null || y === null) return x === y;
      if (Array.isArray(x) || Array.isArray(y)) {
        if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) if (x[i] === undefined || !sameValue(x[i], y[i])) return false;
        return true;
      }
      if (!isPlain(x as object) || !isPlain(y as object)) return false;
      const xk = definedKeys(x as object);
      const yk = definedKeys(y as object);
      return xk.length === yk.length && xk.every((k, i) => k === yk[i] && sameValue((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
    }
    default:
      return false;
  }
}

const isPlain = (o: object): boolean => {
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
};

function definedKeys(o: object): string[] {
  return Object.keys(o)
    .filter((k) => (o as Record<string, unknown>)[k] !== undefined)
    .sort();
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

// Pass the final allow residual (deny parts already under `not`): binding a bare deny residual fails open.
export function bindRefs(f: ResourceFilter, scope: { principal: Principal; env: Readonly<Record<string, unknown>> }): ResourceFilter {
  return simplify(bind(f, scope, false));
}

const MISSING = Symbol('missing');
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

const isRef = (v: object): v is { ref: string } => isPlain(v) && Object.keys(v).length === 1 && Object.hasOwn(v, 'ref') && typeof (v as { ref?: unknown }).ref === 'string';

function bind(f: ResourceFilter, scope: { principal: Principal; env: Readonly<Record<string, unknown>> }, negated: boolean): ResourceFilter {
  switch (f.op) {
    case 'and':
    case 'or':
      return { op: f.op, args: (f as Junction).args.map((x) => bind(x, scope, negated)) };
    case 'not':
      return { op: 'not', arg: bind((f as Negation).arg, scope, !negated) };
    case 'cmp': {
      // Fail closed (B16): FALSE under an even number of nots, TRUE under an odd one, so a missing ref never widens access.
      const missing = negated ? TRUE : FALSE;
      const value = (f as Comparison).value;
      if (Array.isArray(value)) return isLiteralList(value) ? f : missing;
      if (value === null || typeof value !== 'object') return f;
      if (!isRef(value)) return missing;

      const [root, ...path] = (value as { ref: string }).ref.split('.');
      if (root !== 'principal' && root !== 'env') return f;

      const bound = resolve(root === 'principal' ? scope.principal : scope.env, path);
      return bound === MISSING ? missing : { ...(f as Comparison), value: bound };
    }
    default:
      return f;
  }
}

// filter skips holes, so a sparse array fails the length check
const isLiteralList = (v: readonly unknown[]): boolean => v.filter((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))).length === v.length;

function resolve(from: unknown, path: readonly string[]): Value | typeof MISSING {
  let v = from;
  for (const segment of path) {
    if (UNSAFE_SEGMENTS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return MISSING;
    v = (v as Record<string, unknown>)[segment];
  }

  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : MISSING;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? MISSING : v.toISOString();
  if (Array.isArray(v)) return isLiteralList(v) ? [...v] : MISSING;
  return MISSING;
}

// Test seam, not part of the contract: fixes the hash seed or replaces the
// hash, so tests can drive distinct nodes into the equality check.
export const filterHashTesting = {
  hash: (f: ResourceFilter): number | null => nodeHash(f),
  reset(options: { seed?: number; hash?: (f: ResourceFilter) => number | null } = {}): void {
    seed = options.seed ?? randomSeed();
    hashOverride = options.hash;
    HASHES = new WeakMap();
  },
};
