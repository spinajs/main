import { evaluateResidual } from '../../src/engine/evaluate.js';

import type { Condition, ConditionFunction, Principal, ResourceFilter, ResourceRef } from '../../src/index.js';

/**
 * Direct Kleene evaluation of a Condition against one row, written from design §5.9 and the
 * filter.ts semantics without the compiler's code. Leaf comparisons go through the engine's
 * `evaluateResidual`, the reference semantics for SQL (F3 decision 10); the kit oracle differs from
 * it on type coercion (see the L3 report). FAULT: some scope.* read cannot resolve
 * (B39: the vote is indeterminate).
 */
export const FAULT = Symbol('fault');
export type Outcome = boolean | null | typeof FAULT;

export interface OracleWorld {
  readonly principal: Principal;
  readonly actor?: Principal;
  readonly env: Readonly<Record<string, unknown>>;
  /** The row's ref and ancestors ([self, ..., GLOBAL]); null = unknown resource. */
  readonly ref: ResourceRef;
  readonly ancestors: readonly ResourceRef[] | null;
  readonly attributes: (ref: ResourceRef) => Readonly<Record<string, unknown>> | null;
  readonly row: Readonly<Record<string, unknown>>;
  readonly functions: ReadonlyMap<string, ConditionFunction>;
}

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const MISSING = Symbol('missing');

function path(from: unknown, segments: readonly string[]): unknown {
  let v = from;
  for (const s of segments) {
    if (UNSAFE.has(s) || v === null || typeof v !== 'object' || !Object.hasOwn(v, s)) return MISSING;
    v = (v as Record<string, unknown>)[s];
  }
  return v === undefined ? MISSING : v;
}

/** A ref as a comparison value: a scalar, a valid Date (ISO) or a list of strings and finite numbers. */
function asValue(v: unknown): unknown {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : MISSING;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? MISSING : v.toISOString();
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) return [...v];
  return MISSING;
}

class Fault extends Error {}

function scopeRead(w: OracleWorld, text: string): unknown {
  const [, type, ...rest] = text.split('.');
  let node: ResourceRef | undefined;
  if (type === '$global') node = { type: '$global' };
  else node = w.ancestors?.find((a) => a.type === type && typeof a.id === 'string');
  if (!node) throw new Fault(text);
  const attrs = w.attributes(node);
  if (attrs === null) throw new Fault(text);
  const v = path(attrs, rest);
  if (v === MISSING || v === null) throw new Fault(text);
  return v;
}

function read(w: OracleWorld, text: string, side: 'attr' | 'value'): unknown {
  const [root, ...rest] = text.split('.');
  let v: unknown;
  switch (root) {
    case 'principal':
      v = path(w.principal, rest);
      break;
    case 'actor':
      v = path(w.actor ?? w.principal, rest);
      break;
    case 'env':
      v = path(w.env, rest);
      break;
    case 'resource':
      v = path(w.row, rest);
      break;
    case 'scope': {
      const s = scopeRead(w, text);
      if (side === 'value' && asValue(s) === MISSING) throw new Fault(text);
      v = s;
      break;
    }
    default:
      throw new Error(`oracle: bad root ${root}`);
  }
  if (side === 'attr') return v === MISSING ? undefined : v;
  return v === MISSING ? MISSING : asValue(v);
}

const OPS = ['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null'];

async function compare(op: string, attr: unknown, operand: unknown, w: OracleWorld): Promise<boolean | null> {
  const f: ResourceFilter = op === 'null' ? { op: 'cmp', field: 'v', cmp: operand === false ? 'notnull' : 'null' } : ({ op: 'cmp', field: 'v', cmp: op, value: operand } as ResourceFilter);
  const env = { principal: w.principal, ref: w.ref, attribute: (s: unknown, k: string) => (s as Record<string, unknown>)[k], relation: () => undefined, ancestors: async () => w.ancestors, native: () => undefined, ctx: undefined as never };
  const t = await evaluateResidual(f, { v: attr }, env);
  return t === undefined ? null : t;
}

function and3(xs: readonly (boolean | null)[]): boolean | null {
  if (xs.includes(false)) return false;
  return xs.includes(null) ? null : true;
}

function or3(xs: readonly (boolean | null)[]): boolean | null {
  if (xs.includes(true)) return true;
  return xs.includes(null) ? null : false;
}

async function evaluate(c: Condition, w: OracleWorld): Promise<boolean | null> {
  const n = c as Record<string, unknown>;
  if (Array.isArray(n.all)) {
    const xs: (boolean | null)[] = [];
    for (const x of n.all as Condition[]) xs.push(await evaluate(x, w));
    return and3(xs);
  }
  if (Array.isArray(n.any)) {
    const xs: (boolean | null)[] = [];
    for (const x of n.any as Condition[]) xs.push(await evaluate(x, w));
    return or3(xs);
  }
  if (n.not !== undefined) {
    const v = await evaluate(n.not as Condition, w);
    return v === null ? null : !v;
  }
  if (typeof n.fn === 'string') {
    let unknown = false;
    const resolve = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(resolve);
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === 'ref' && typeof (v as { ref: unknown }).ref === 'string') {
        const r = read(w, (v as { ref: string }).ref, 'value');
        if (r === MISSING) unknown = true;
        return r === MISSING ? undefined : r;
      }
      return Object.fromEntries(keys.map((k) => [k, resolve((v as Record<string, unknown>)[k])]));
    };
    const args = resolve(n.args ?? {});
    if (unknown) return null;
    return w.functions.get(n.fn)!.evaluate(args, { principal: w.principal, ...(w.actor ? { actor: w.actor } : {}), env: w.env });
  }
  const op = OPS.find((o) => Object.hasOwn(n, o))!;
  const raw = n[op];
  const isRef = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const operand = isRef ? read(w, (raw as { ref: string }).ref, 'value') : raw;
  const attr = read(w, n.attr as string, 'attr');
  if (operand === MISSING) return op === 'null' ? compare(op, attr, raw, w) : null;
  return compare(op, attr, operand, w);
}

/** Every scope read the compiler makes, wherever it sits in the tree. */
function scopeFaults(c: unknown, w: OracleWorld): boolean {
  if (c === null || typeof c !== 'object') return false;
  if (Array.isArray(c)) return c.some((x) => scopeFaults(x, w));
  const n = c as Record<string, unknown>;
  const refs: { text: string; side: 'attr' | 'value' }[] = [];
  if (typeof n.attr === 'string') refs.push({ text: n.attr, side: 'attr' });
  if (typeof n.ref === 'string' && Object.keys(n).length === 1) refs.push({ text: n.ref, side: 'value' });
  for (const r of refs) {
    if (!r.text.startsWith('scope.')) continue;
    try {
      read(w, r.text, r.side);
    } catch (e) {
      if (e instanceof Fault) return true;
      throw e;
    }
  }
  return Object.values(n).some((x) => scopeFaults(x, w));
}

export async function oracle(c: Condition, w: OracleWorld): Promise<Outcome> {
  if (scopeFaults(c, w)) return FAULT;
  return evaluate(c, w);
}
