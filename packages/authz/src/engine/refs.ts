import { FALSE, TRUE, simplify } from '../contracts/filter.js';
import type { ResourceFilter, Value } from '../contracts/filter.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Principal, ResourceRef } from '../contracts/principal.js';
import { GLOBAL } from '../contracts/resource.js';

const MAX_DEPTH = 1024;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MISSING = Symbol('missing');

type Node = Record<string, unknown>;
type Literal = Exclude<Value, null | { readonly ref: string }>;

export type RefSource = {
  readonly actor: Principal;
  /** undefined: the ref has no id. */
  readonly ancestors: readonly ResourceRef[] | undefined;
  /** Value or promise of the attributes; null = unknown node. */
  attributes(ref: ResourceRef): unknown;
};

/** Distinct ref strings left in cmp values, in depth-first order; each shared node is visited once. */
export function collectRefs(f: ResourceFilter): readonly string[] {
  const found = new Set<string>();
  const visited = new WeakSet<object>();
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || visited.has(node)) return;
    if (depth > MAX_DEPTH) throw new AuthzConfigError(`filter nested deeper than ${MAX_DEPTH}`);
    visited.add(node);
    const n = node as Node;
    const op = n.op;
    if (op === 'and' || op === 'or') {
      const args = n.args;
      if (Array.isArray(args)) for (const arg of args) walk(arg, depth + 1);
    } else if (op === 'not') {
      walk(n.arg, depth + 1);
    } else if (op === 'cmp') {
      const r = refOf(n.value);
      if (r !== undefined) found.add(r);
    }
  };
  walk(f, 0);
  return Object.freeze([...found]);
}

const hasRoot = (r: string, root: string): boolean => r === root || r.startsWith(`${root}.`);

/** Call before `bindRefs`, which replaces the env refs. */
export function hasEnvRef(f: ResourceFilter): boolean {
  return collectRefs(f).some((r) => hasRoot(r, 'env'));
}

/** Call before `bindRefs`. The L2 key leaves `identity` out, so a residual bound from it must not be cached. */
export function readsIdentity(f: ResourceFilter): boolean {
  return collectRefs(f).some((r) => hasRoot(r, 'actor.identity') || hasRoot(r, 'principal.identity'));
}

/** For each `scope.<type>.…` ref, the nearest ancestor of `<type>`; `$global` resolves to GLOBAL on any request. */
export function scopeNodes(refs: readonly string[], source: Pick<RefSource, 'ancestors'>): ReadonlyMap<string, ResourceRef> {
  const nodes = new Map<string, ResourceRef>();
  const ancestors = Array.isArray(source.ancestors) ? source.ancestors : undefined;
  for (const r of refs) {
    if (typeof r !== 'string') continue;
    const parts = r.split('.');
    if (parts[0] !== 'scope' || parts.length < 3 || parts[1] === '' || nodes.has(parts[1])) continue;
    const type = parts[1];
    if (type === GLOBAL.type) {
      nodes.set(type, GLOBAL);
      continue;
    }
    // On a ref without id the rows may differ in this ancestor (design §5.9).
    if (ancestors === undefined) continue;
    const nearest = ancestors.find((a) => a?.type === type);
    // A nearest node without id is "some node": going further up would read another node's attributes.
    if (nearest !== undefined && typeof nearest.id === 'string') nodes.set(type, Object.freeze({ type, id: nearest.id }));
  }
  return nodes;
}

/** Values for each ref; a missing value is absent from the map. `attributesByType`: what the engine loaded for `scopeNodes` (null = unknown node). */
export function refValues(refs: readonly string[], actor: Principal, attributesByType: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>): ReadonlyMap<string, Value> {
  const out = new Map<string, Value>();
  for (const r of refs) {
    if (typeof r !== 'string' || out.has(r)) continue;
    const [root, ...path] = r.split('.');
    let from: unknown;
    if (root === 'actor') {
      from = actor;
    } else if (root === 'scope' && path.length > 0) {
      from = attributesByType.get(path.shift()!);
      if (from === null || from === undefined) continue;
    } else {
      continue;
    }
    if (path.length === 0) continue;
    const v = resolve(from, path);
    if (v !== MISSING) out.set(r, v);
  }
  return out;
}

/**
 * Replaces every ref in a cmp value: known ⇒ its literal; missing ⇒ the whole
 * cmp becomes FALSE under an even number of `not`s and TRUE under an odd
 * number, so a missing value never widens access. A node with an op outside
 * the core set and `native:*` is replaced the same way. Returns a simplified
 * filter.
 */
export function bindEngineRefs(f: ResourceFilter, values: ReadonlyMap<string, Value>): ResourceFilter {
  const memo = [new WeakMap<object, ResourceFilter>(), new WeakMap<object, ResourceFilter>()];

  const bind = (node: unknown, negated: boolean, depth: number): ResourceFilter => {
    if (node === null || typeof node !== 'object') throw new AuthzConfigError('malformed filter node');
    if (depth > MAX_DEPTH) throw new AuthzConfigError(`filter nested deeper than ${MAX_DEPTH}`);
    const cache = memo[negated ? 1 : 0];
    let out = cache.get(node);
    if (out === undefined) {
      out = bindFresh(node as Node, negated, depth);
      cache.set(node, out);
    }
    return out;
  };

  // Children are already simplified, so simplify here is linear in the distinct nodes.
  const bindFresh = (n: Node, negated: boolean, depth: number): ResourceFilter => {
    const op = n.op;
    switch (op) {
      case 'and':
      case 'or': {
        const args = n.args;
        if (!Array.isArray(args)) throw new AuthzConfigError(`malformed ${op} node`);
        const out: ResourceFilter[] = [];
        for (let i = 0; i < args.length; i++) {
          if (!(i in args)) throw new AuthzConfigError(`malformed ${op} node`);
          out.push(bind(args[i], negated, depth + 1));
        }
        return simplify({ op, args: out });
      }
      case 'not':
        return simplify({ op, arg: bind(n.arg, !negated, depth + 1) });
      case 'cmp':
        return bindCmp(n, negated ? TRUE : FALSE, values);
      case 'true':
      case 'false':
      case 'relation':
      case 'under':
        return simplify(n as ResourceFilter);
      default:
        // An op this binder does not know could hide a ref, so it counts as missing.
        return typeof op === 'string' && op.startsWith('native:') && op.length > 'native:'.length ? (n as ResourceFilter) : negated ? TRUE : FALSE;
    }
  };

  return simplify(bind(f, false, 0));
}

/** A fresh frozen cmp built from values read once; malformed parts count as missing. */
function bindCmp(n: Node, missing: ResourceFilter, values: ReadonlyMap<string, Value>): ResourceFilter {
  const { field, cmp } = n;
  const raw = n.value;
  if (typeof field !== 'string' || typeof cmp !== 'string') return missing;

  let value: unknown = raw;
  if (raw !== null && typeof raw === 'object') {
    const r = refOf(raw);
    const literal = r === undefined ? (Array.isArray(raw) ? literalList(raw) : MISSING) : literalOf(values.get(r));
    if (literal === MISSING) return missing;
    value = literal;
  } else if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'boolean' && !(typeof raw === 'number' && Number.isFinite(raw))) {
    return missing;
  }

  return Object.freeze(raw === undefined ? { op: 'cmp', field, cmp } : { op: 'cmp', field, cmp, value }) as ResourceFilter;
}

function refOf(v: unknown): string | undefined {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const keys = Object.keys(v);
    if (keys.length !== 1 || keys[0] !== 'ref') return undefined;
    const r = (v as { ref?: unknown }).ref;
    return typeof r === 'string' ? r : undefined;
  } catch {
    return undefined;
  }
}

function literalOf(v: unknown): Literal | typeof MISSING {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : MISSING;
  return Array.isArray(v) ? literalList(v) : MISSING;
}

/** A frozen copy of a list of strings and finite numbers, each element read once. */
function literalList(v: readonly unknown[]): readonly (string | number)[] | typeof MISSING {
  try {
    const length = v.length;
    const out: (string | number)[] = [];
    for (let i = 0; i < length; i++) {
      if (!(i in v)) return MISSING;
      const item = v[i];
      if (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))) return MISSING;
      out.push(item);
    }
    return Object.freeze(out);
  } catch {
    return MISSING;
  }
}

/** Own properties only, each read once; the same leaf rules as the contract `bindRefs`. */
function resolve(from: unknown, path: readonly string[]): Value | typeof MISSING {
  try {
    let v = from;
    for (const segment of path) {
      if (UNSAFE_SEGMENTS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return MISSING;
      v = (v as Record<string, unknown>)[segment];
    }
    if (v instanceof Date) {
      const t = Date.prototype.getTime.call(v);
      return Number.isNaN(t) ? MISSING : new Date(t).toISOString();
    }
    return literalOf(v);
  } catch {
    return MISSING;
  }
}
