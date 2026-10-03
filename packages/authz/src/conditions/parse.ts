import Ajv from 'ajv';

import { AuthzConfigError } from '../contracts/errors.js';
import type { ResourceType } from '../contracts/principal.js';
import { CONDITION_SCHEMA } from './schema.js';

export const MAX_CONDITION_DEPTH = 32;
export const MAX_CONDITION_NODES = 1000;
/** Bounds the raw input (operands, `in` lists, function args) before any recursive check runs. */
export const MAX_CONDITION_VALUES = 10000;

export const CONDITION_OPS = Object.freeze(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null'] as const);
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type ConditionRoot = 'principal' | 'actor' | 'resource' | 'env' | 'scope';

/** A dotted attribute or ref: `principal.attributes.pool`, `scope.org.policies.open`. */
export interface ConditionPath {
  readonly root: ConditionRoot;
  /** Only for `scope`: the ancestor type. */
  readonly scopeType?: ResourceType;
  /** Segments after the root (and after the scope type). */
  readonly path: readonly string[];
  readonly text: string;
}

export type ConditionLiteral = string | number | boolean | null | readonly (string | number)[];

export type ConditionOperand = { readonly kind: 'literal'; readonly value: ConditionLiteral } | { readonly kind: 'ref'; readonly ref: ConditionPath };

/** What a subtree reads; the compiler and the models decide binding, caching and boot refs from it. */
export interface ConditionFacts {
  readonly roots: readonly ConditionRoot[];
  readonly scopeTypes: readonly ResourceType[];
  readonly functions: readonly string[];
  /** Every attr and ref text, attr side and value side, function args included. */
  readonly refs: readonly string[];
}

export type ParsedCondition = { readonly kind: 'all' | 'any'; readonly items: readonly ParsedCondition[]; readonly facts: ConditionFacts } | { readonly kind: 'not'; readonly item: ParsedCondition; readonly facts: ConditionFacts } | { readonly kind: 'cmp'; readonly attr: ConditionPath; readonly op: ConditionOp; readonly operand: ConditionOperand; readonly facts: ConditionFacts } | { readonly kind: 'fn'; readonly name: string; readonly args: Readonly<Record<string, unknown>>; readonly facts: ConditionFacts };

export interface ParseConditionOptions {
  /** Names of the registered condition functions. */
  readonly functions: { has(name: string): boolean };
  /** Prefix of error messages: `abac policy 'p1' when`. */
  readonly where?: string;
}

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const ATTR_ROOTS: ReadonlySet<string> = new Set(['principal', 'actor', 'resource', 'env', 'scope']);
// A row-to-row comparison has no residual form, so a value never refers to the resource.
const VALUE_ROOTS: ReadonlySet<string> = new Set(['principal', 'actor', 'env', 'scope']);

/**
 * Validates `input` as a `Condition` (design §5.9) and returns its frozen, checked form.
 * Throws `AuthzConfigError` naming `where` and the path inside the condition; never anything else.
 */
export function parseCondition(input: unknown, options: ParseConditionOptions): ParsedCondition {
  const where = options.where ?? 'condition';
  const data = snapshot(input, where);
  if (!validator()(data)) throw new AuthzConfigError(`${where}: ${describeAjvError(validator().errors ?? [])}`);
  const counter = { nodes: 0 };
  return build(data as Json, '', 0, counter, where, options.functions);
}

// ---- input snapshot: plain JSON, bounded, no cycles, no accessors that throw ----

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function snapshot(input: unknown, where: string): Json {
  let values = 0;
  const path = new Set<object>();
  const fail = (at: string, text: string): never => {
    throw new AuthzConfigError(`${where}: ${text} at ${at || '(root)'}`);
  };

  const copy = (v: unknown, at: string, depth: number): Json => {
    if (++values > MAX_CONDITION_VALUES) fail(at, `condition holds more than ${MAX_CONDITION_VALUES} values`);
    if (depth > MAX_CONDITION_DEPTH * 2 + 4) fail(at, `condition nested deeper than ${MAX_CONDITION_DEPTH}`);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : fail(at, `${String(v)} is not a finite number`);
    if (typeof v !== 'object') return fail(at, `${typeof v} is not a JSON value`);
    if (path.has(v)) fail(at, 'condition holds a cycle');
    path.add(v);
    try {
      if (Array.isArray(v)) {
        const out: Json[] = [];
        for (let i = 0; i < v.length; i++) {
          if (!Object.hasOwn(v, i)) fail(`${at}[${i}]`, 'array has a hole');
          out.push(copy(v[i], `${at}[${i}]`, depth + 1));
        }
        return out;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) fail(at, 'condition holds a non-plain object');
      const out: { [k: string]: Json } = {};
      for (const k of Object.keys(v)) {
        const item = (v as Record<string, unknown>)[k];
        if (item === undefined) continue;
        // defineProperty: a '__proto__' key stays an own property instead of changing the prototype
        Object.defineProperty(out, k, { value: copy(item, `${at}.${k}`, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    } catch (e) {
      if (e instanceof AuthzConfigError) throw e;
      return fail(at, `reading the condition failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      path.delete(v);
    }
  };

  return copy(input, '', 0);
}

// ---- AJV ----

type Validate = ((data: unknown) => boolean) & { errors?: readonly AjvError[] | null };
interface AjvError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message?: string;
  readonly params: Record<string, unknown>;
}

let compiled: Validate | undefined;

function validator(): Validate {
  if (compiled) return compiled;
  // ajv's CJS default export is the class itself; under ESM interop it sits on `.default`.
  const AjvClass = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as new (opts: object) => { compile(schema: object): Validate };
  compiled = new AjvClass({ allErrors: false, strict: false }).compile(CONDITION_SCHEMA);
  return compiled;
}

const OPERANDS: Readonly<Record<string, string>> = {
  eq: 'a string, number, boolean, null or {ref}',
  ne: 'a string, number, boolean, null or {ref}',
  in: 'a list of strings and numbers or {ref}',
  nin: 'a list of strings and numbers or {ref}',
  lt: 'a string, number, boolean or {ref}',
  lte: 'a string, number, boolean or {ref}',
  gt: 'a string, number, boolean or {ref}',
  gte: 'a string, number, boolean or {ref}',
  like: 'a string or {ref}',
  glob: 'a string or {ref}',
  wildcard: 'a string or {ref}',
};

function describeAjvError(errors: readonly AjvError[]): string {
  // An anyOf error comes after its branches' errors and says more than any of them;
  // `if` errors only say which branch failed, the branch's own error follows them.
  const e = [...errors].reverse().find((x) => x.keyword === 'anyOf') ?? errors.find((x) => x.keyword !== 'if') ?? errors[0];
  if (!e) return 'invalid condition';
  const at = pointerToPath(e.instancePath) || '(root)';
  switch (e.keyword) {
    case 'anyOf': {
      const op = e.instancePath.split('/').pop() ?? '';
      return Object.hasOwn(OPERANDS, op) ? `'${op}' takes ${OPERANDS[op]} at ${at}` : `a condition needs one of all, any, not, attr, fn at ${at}`;
    }
    case 'additionalProperties':
      return `unexpected key ${JSON.stringify(e.params.additionalProperty)} at ${at}`;
    case 'minProperties':
      return `an attr condition needs one operator (${CONDITION_OPS.join(', ')}) at ${at}`;
    case 'maxProperties':
      return `an attr condition takes exactly one operator at ${at}`;
    default:
      return `${e.message ?? 'invalid'} at ${at}`;
  }
}

function pointerToPath(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`))
    .join('');
}

// ---- semantic pass ----

function build(node: Json, at: string, depth: number, counter: { nodes: number }, where: string, functions: { has(name: string): boolean }): ParsedCondition {
  const fail = (text: string, path = at): never => {
    throw new AuthzConfigError(`${where}: ${text} at ${path || '(root)'}`);
  };
  if (depth >= MAX_CONDITION_DEPTH) fail(`condition nested deeper than ${MAX_CONDITION_DEPTH}`);
  if (++counter.nodes > MAX_CONDITION_NODES) fail(`condition has more than ${MAX_CONDITION_NODES} nodes`);

  const n = node as { [k: string]: Json };
  if (Object.hasOwn(n, 'all') || Object.hasOwn(n, 'any')) {
    const kind = Object.hasOwn(n, 'all') ? 'all' : 'any';
    const items = (n[kind] as Json[]).map((c, i) => build(c, `${at}.${kind}[${i}]`, depth + 1, counter, where, functions));
    return freeze({ kind, items: Object.freeze(items), facts: merge(items.map((i) => i.facts)) });
  }
  if (Object.hasOwn(n, 'not')) {
    const item = build(n.not, `${at}.not`, depth + 1, counter, where, functions);
    return freeze({ kind: 'not', item, facts: item.facts });
  }
  if (Object.hasOwn(n, 'fn')) {
    const name = n.fn as string;
    if (!functions.has(name)) fail(`unknown condition function ${JSON.stringify(name)}`, `${at}.fn`);
    const args = (n.args ?? {}) as { [k: string]: Json };
    const refs: ConditionPath[] = [];
    collectArgRefs(args, `${at}.args`, refs, fail);
    return freeze({ kind: 'fn', name, args: deepFreeze(args), facts: factsOf(refs, [name]) });
  }

  const attr = parsePath(n.attr as string, ATTR_ROOTS, `${at}.attr`, fail);
  const op = Object.keys(n).find((k) => k !== 'attr') as ConditionOp;
  const raw = n[op];
  let operand: ConditionOperand;
  if (isRefObject(raw)) {
    const value = parsePath(raw.ref, VALUE_ROOTS, `${at}.${op}.ref`, fail);
    operand = Object.freeze({ kind: 'ref', ref: value });
  } else {
    operand = Object.freeze({ kind: 'literal', value: deepFreeze(raw) as ConditionLiteral });
  }
  const refs = operand.kind === 'ref' ? [attr, operand.ref] : [attr];
  return freeze({ kind: 'cmp', attr, op, operand, facts: factsOf(refs, []) });
}

function parsePath(text: string, roots: ReadonlySet<string>, at: string, fail: (text: string, path?: string) => never): ConditionPath {
  const parts = text.split('.');
  const root = parts[0];
  if (!roots.has(root)) fail(`${JSON.stringify(text)} must start with ${[...roots].map((r) => (r === 'scope' ? 'scope.<type>' : r)).join(', ')}`, at);
  for (const s of parts) {
    if (s === '') fail(`${JSON.stringify(text)} has an empty segment`, at);
    if (UNSAFE_SEGMENTS.has(s)) fail(`${JSON.stringify(text)} uses the reserved segment ${JSON.stringify(s)}`, at);
  }
  if (root === 'scope') {
    if (parts.length < 3) fail(`${JSON.stringify(text)} must read scope.<type>.<path>`, at);
    // ':' would break resourceKey's injectivity, the same rule the core applies to types.
    if (parts[1].includes(':')) fail(`${JSON.stringify(text)} names an invalid resource type`, at);
    return Object.freeze({ root: 'scope', scopeType: parts[1], path: Object.freeze(parts.slice(2)), text });
  }
  if (parts.length < 2) fail(`${JSON.stringify(text)} needs a path after ${root}`, at);
  return Object.freeze({ root: root as ConditionRoot, path: Object.freeze(parts.slice(1)), text });
}

function isRefObject(v: Json | undefined): v is { ref: string } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.ref === 'string';
}

function collectArgRefs(v: Json, at: string, out: ConditionPath[], fail: (text: string, path?: string) => never): void {
  if (v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectArgRefs(x, `${at}[${i}]`, out, fail));
    return;
  }
  if (isRefObject(v)) {
    out.push(parsePath(v.ref, ATTR_ROOTS, `${at}.ref`, fail));
    return;
  }
  for (const k of Object.keys(v)) collectArgRefs(v[k], `${at}.${k}`, out, fail);
}

const EMPTY: readonly never[] = Object.freeze([]);

function factsOf(paths: readonly ConditionPath[], functions: readonly string[]): ConditionFacts {
  return Object.freeze({
    roots: sortedUnique(paths.map((p) => p.root)),
    scopeTypes: sortedUnique(paths.flatMap((p) => (p.scopeType === undefined ? [] : [p.scopeType]))),
    functions: sortedUnique(functions),
    refs: sortedUnique(paths.map((p) => p.text)),
  });
}

function merge(all: readonly ConditionFacts[]): ConditionFacts {
  return Object.freeze({
    roots: sortedUnique(all.flatMap((f) => f.roots)),
    scopeTypes: sortedUnique(all.flatMap((f) => f.scopeTypes)),
    functions: sortedUnique(all.flatMap((f) => f.functions)),
    refs: sortedUnique(all.flatMap((f) => f.refs)),
  });
}

function sortedUnique<T extends string>(xs: readonly T[]): readonly T[] {
  if (xs.length === 0) return EMPTY;
  return Object.freeze([...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

function freeze<T extends object>(x: T): T {
  return Object.freeze(x);
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}
