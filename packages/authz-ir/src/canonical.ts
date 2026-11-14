import { createHash } from 'node:crypto';

import type { PolicyIR, RelationDef, Rewrite, TypeDef } from './ir.js';

/**
 * Stable JSON of the IR, the input of `policyHash`: object keys sorted, `undefined` properties dropped,
 * `union` and `intersection` operands and the set-valued `allowed` and `opaque` lists sorted. `priority`,
 * condition lists and combine model lists keep their order, since it is meaningful.
 */
export function canonicalize(ir: PolicyIR): string {
  return stableStringify(normalize(ir));
}

/** SHA-256 hex of `canonicalize(ir)`. */
export function policyHash(ir: PolicyIR): string {
  return createHash('sha256').update(canonicalize(ir)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

const sortedBy = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  items
    .map((item) => ({ item, k: key(item) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.item);

function normalize(ir: PolicyIR): PolicyIR {
  return {
    ...ir,
    types: mapValues(ir.types, normalizeType),
    opaque: sortedBy(ir.opaque, stableStringify),
  };
}

function normalizeType(t: TypeDef): TypeDef {
  return {
    ...t,
    relations: mapValues(t.relations, (r: RelationDef) => ({ ...r, allowed: sortedBy(r.allowed, stableStringify) })),
    permissions: mapValues(t.permissions, normalizeRewrite),
  };
}

export function normalizeRewrite(r: Rewrite): Rewrite {
  if ('union' in r) return { union: sortedBy(r.union.map(normalizeRewrite), stableStringify) };
  if ('intersection' in r) return { intersection: sortedBy(r.intersection.map(normalizeRewrite), stableStringify) };
  if ('exclusion' in r) return { exclusion: { base: normalizeRewrite(r.exclusion.base), subtract: normalizeRewrite(r.exclusion.subtract) } };
  if ('caveat' in r) return { caveat: r.caveat, of: normalizeRewrite(r.of) };
  if ('priority' in r) return { priority: r.priority.map((p) => ({ when: normalizeRewrite(p.when), then: p.then })) };
  return r;
}

function mapValues<T, U>(record: Record<string, T>, f: (v: T) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const k of Object.keys(record)) Object.defineProperty(out, k, { value: f(record[k]), enumerable: true, writable: true, configurable: true });
  return out;
}
