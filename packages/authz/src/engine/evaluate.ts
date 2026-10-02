import type { ResourceFilter } from '../contracts/filter.js';
import type { Principal, ResourceRef, ResourceType } from '../contracts/principal.js';
import type { RelationResolver } from '../contracts/adapter.js';
import type { EvaluationContext, NativeFilter } from '../contracts/model.js';

/** Kleene truth value: `undefined` is UNKNOWN. */
export type Truth = boolean | undefined;

export interface SubjectEnv {
  readonly principal: Principal;
  readonly ref: ResourceRef;
  attribute(subject: unknown, field: string): unknown;
  relation(type: ResourceType, name: string): RelationResolver | undefined;
  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null>;
  native(op: string): NativeFilter | undefined;
  readonly ctx: EvaluationContext;
}

const MAX_DEPTH = 256;
const MAX_MATCH_WORK = 4_000_000;
// One budget per evaluation, so a residual that shares subtrees (linear in
// memory, exponential as a tree) or repeats heavy leaves cannot stall the
// event loop. A unit is about one DP cell or one list element; an awaited
// node visit costs about 64 of them. Leaves pay for their own work on top.
const BUDGET = 8_000_000;
const NODE_COST = 64;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

// The SQL compilation of a residual must reproduce these semantics exactly.
export function evaluateResidual(f: ResourceFilter, subject: unknown, env: SubjectEnv): Promise<Truth> {
  return node(f, { subject, env, budget: BUDGET, attributes: new Map(), leaves: new Map() }, 1).catch(() => undefined);
}

export function defaultAttribute(subject: unknown, field: string): unknown {
  try {
    let v: unknown = subject;
    for (const segment of field.split('.')) {
      if (UNSAFE_SEGMENTS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return undefined;
      v = (v as Record<string, unknown>)[segment];
    }
    return v;
  } catch {
    return undefined;
  }
}

/** A ref copied out of untrusted input, each field read once. */
interface Ref {
  readonly type: string;
  readonly id: string | undefined;
}

interface Run {
  readonly subject: unknown;
  readonly env: SubjectEnv;
  budget: number;
  // A row has one value per column, so each field is read once per evaluation.
  readonly attributes: Map<string, Attr | undefined>;
  // A leaf's value depends on the node, the subject and the env only, so a
  // shared leaf is worked out (and a relation or native filter called) once.
  // Junctions are not memoised: their value also depends on the depth cap.
  readonly leaves: Map<object, Truth>;
  ancestors?: Promise<AncestorIndex | undefined>;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

// Once a charge fails the budget is zero, so every later node is UNKNOWN too.
function charge(run: Run, cost: number): boolean {
  if (cost > run.budget) {
    run.budget = 0;
    return false;
  }
  run.budget -= cost;
  return true;
}

async function node(f: unknown, run: Run, depth: number): Promise<Truth> {
  if (depth > MAX_DEPTH || !charge(run, NODE_COST)) return undefined;
  try {
    if (!isObject(f)) return undefined;
    const op = f.op;
    if (typeof op !== 'string') return undefined;

    switch (op) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'and':
      case 'or':
        return await junction(op, f.args, run, depth);
      case 'not': {
        const arg = f.arg;
        const v = isObject(arg) ? await node(arg, run, depth + 1) : undefined;
        return v === undefined ? undefined : !v;
      }
      default:
        return await leaf(f, op, run);
    }
  } catch {
    return undefined;
  }
}

async function leaf(f: Record<string, unknown>, op: string, run: Run): Promise<Truth> {
  if (run.leaves.has(f)) return run.leaves.get(f);
  let v: Truth;
  try {
    v = await leafValue(f, op, run);
  } catch {
    v = undefined;
  }
  run.leaves.set(f, v);
  return v;
}

async function leafValue(f: Record<string, unknown>, op: string, run: Run): Promise<Truth> {
  switch (op) {
    case 'cmp':
      return comparison(f, run);
    case 'relation':
      return await relation(f.relation, run);
    case 'under':
      return await under(f.scopes, run);
    default:
      return op.startsWith('native:') ? await native(op, f.args, run) : undefined;
  }
}

async function junction(op: 'and' | 'or', args: unknown, run: Run, depth: number): Promise<Truth> {
  if (!Array.isArray(args)) return undefined;
  const zero = op === 'or';
  const length = args.length;
  let unknown = false;
  for (let i = 0; i < length; i++) {
    const arg: unknown = args[i];
    const v = isObject(arg) ? await node(arg, run, depth + 1) : undefined;
    if (v === zero) return zero;
    if (v === undefined) unknown = true;
  }
  return unknown ? undefined : !zero;
}

// ---- cmp ----

const INCOMPARABLE = Symbol('incomparable');
type Scalar = string | number | boolean;
type Attr = Scalar | null | typeof INCOMPARABLE;

const KNOWN_CMP = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null', 'notnull']);

function normalizeAttribute(v: unknown): Attr {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : INCOMPARABLE;
  if (v instanceof Date) {
    // Through the prototype: a subclass or a fake built on Date.prototype cannot fake the instant.
    let time: number;
    try {
      time = Date.prototype.getTime.call(v);
    } catch {
      return INCOMPARABLE;
    }
    if (Number.isNaN(time)) return null;
    const date = new Date(time);
    const year = date.getUTCFullYear();
    // Outside 0000-9999 the ISO form carries a sign ('+010000-...'), and code point order stops following time.
    return year < 0 || year > 9999 ? INCOMPARABLE : date.toISOString();
  }
  return INCOMPARABLE;
}

const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const isListItem = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

// Copied by index with the length read once, so an own iterator or a getter
// cannot show one value to the check and another to the use. A hole reads as
// undefined and fails the check. Charged by length before the copy, and by
// the string lengths (which the comparisons walk) after it.
function literalList(v: unknown, run: Run): readonly (string | number)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const length = v.length;
  if (!charge(run, length)) return undefined;
  const out: (string | number)[] = [];
  let chars = 0;
  for (let i = 0; i < length; i++) {
    const item: unknown = v[i];
    if (!isListItem(item)) return undefined;
    if (typeof item === 'string') chars += item.length;
    out.push(item);
  }
  return charge(run, chars) ? out : undefined;
}

const stringCost = (...values: unknown[]): number => values.reduce<number>((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);

function comparison(f: Record<string, unknown>, run: Run): Truth {
  const field = f.field;
  const op = f.cmp;
  if (typeof field !== 'string' || typeof op !== 'string') return undefined;

  if (op === 'in' || op === 'nin') {
    const list = literalList(f.value, run);
    if (list === undefined) return undefined;
    // Agrees with F1 simplify, which turns `in []` into FALSE and `nin []` into TRUE without reading the row.
    if (list.length === 0) return op === 'nin';
    const attr = readAttribute(field, run);
    if (attr === undefined || attr === null || attr === INCOMPARABLE || !charge(run, stringCost(attr))) return undefined;
    // Parsed once, not once per element.
    const attrNumber = typeof attr === 'string' ? numericString(attr) : undefined;
    // SQL OR of equalities: an element eq cannot compare leaves a miss UNKNOWN.
    let found: Truth = false;
    for (let i = 0; i < list.length; i++) {
      const eq = itemEquals(attr, attrNumber, list[i]);
      if (eq === true) {
        found = true;
        break;
      }
      if (eq === undefined) found = undefined;
    }
    return found === undefined ? undefined : op === 'in' ? found : !found;
  }

  if (!KNOWN_CMP.has(op)) return undefined;
  const attr = readAttribute(field, run);
  if (attr === undefined) return undefined;

  switch (op) {
    case 'null':
      return attr === null;
    case 'notnull':
      return attr !== null;
    case 'like':
    case 'glob':
    case 'wildcard': {
      const pattern = f.value;
      if (typeof attr !== 'string' || typeof pattern !== 'string') return undefined;
      // Tokenising costs about a node visit per pattern character, whatever the text.
      if (overCap(pattern, attr) || !charge(run, (pattern.length + 1) * (attr.length + 1) + NODE_COST * pattern.length)) return undefined;
      return op === 'like' ? matchLike(pattern, attr) : op === 'glob' ? matchGlob(pattern, attr) : matchWildcard(pattern, attr);
    }
  }

  const value = f.value;
  if (attr === null || attr === INCOMPARABLE || !isScalar(value) || !charge(run, stringCost(attr, value))) return undefined;
  const pair = coerce(attr, value);
  if (pair === undefined) return undefined;
  const [a, b] = pair;

  if (op === 'eq') return a === b;
  if (op === 'ne') return a !== b;
  if (typeof a === 'boolean') return undefined;
  const order = typeof a === 'number' ? a - (b as number) : compareCodePoints(a, b as string);
  switch (op) {
    case 'lt':
      return order < 0;
    case 'lte':
      return order <= 0;
    case 'gt':
      return order > 0;
    case 'gte':
      return order >= 0;
  }
  return undefined;
}

/** `undefined`: the reader threw or handed back a native promise. */
function readAttribute(field: string, run: Run): Attr | undefined {
  if (run.attributes.has(field)) return run.attributes.get(field);
  const attr = readAttributeOnce(field, run);
  run.attributes.set(field, attr);
  return attr;
}

function readAttributeOnce(field: string, run: Run): Attr | undefined {
  let raw: unknown;
  try {
    raw = run.env.attribute(run.subject, field);
    // A native promise means an async reader: broken, and its rejection must
    // not go unhandled. Any other thenable (an ORM lazy relation) is a plain
    // value, and its then is never called.
    if (isObject(raw) && Object.getPrototypeOf(raw) === Promise.prototype) {
      if (!Object.hasOwn(raw, 'constructor')) Promise.prototype.then.call(raw, undefined, () => undefined);
      return undefined;
    }
  } catch {
    return undefined;
  }
  return normalizeAttribute(raw);
}

/** `eq` coercion for one list element, with a string attribute's numeric reading worked out by the caller. */
function itemEquals(attr: Scalar, attrNumber: number | undefined, item: string | number): Truth {
  if (typeof attr === typeof item) return attr === item;
  if (typeof attr === 'string') return attrNumber === undefined ? undefined : attrNumber === item;
  if (typeof attr === 'number') {
    const n = numericString(item as string);
    return n === undefined ? undefined : attr === n;
  }
  return item === 0 || item === 1 ? attr === (item === 1) : undefined;
}

// 'NaN' and 'Infinity' survive the round trip, so finiteness is checked too.
const numericString = (s: string): number | undefined => {
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : undefined;
};

function coerce(a: Scalar, b: Scalar): readonly [Scalar, Scalar] | undefined {
  if (typeof a === typeof b) return [a, b];
  if (typeof a === 'number' && typeof b === 'string') {
    const n = numericString(b);
    return n === undefined ? undefined : [a, n];
  }
  if (typeof a === 'string' && typeof b === 'number') {
    const n = numericString(a);
    return n === undefined ? undefined : [n, b];
  }
  if (typeof a === 'boolean' && typeof b === 'number') return b === 0 || b === 1 ? [a, b === 1] : undefined;
  if (typeof a === 'number' && typeof b === 'boolean') return a === 0 || a === 1 ? [a === 1, b] : undefined;
  return undefined;
}

// Surrogates (D800-DFFF) move above E000-FFFF, so UTF-16 units compare in code point order.
const fixup = (c: number): number => (c >= 0xe000 ? c - 0x800 : c >= 0xd800 ? c + 0x2000 : c);

function compareCodePoints(x: string, y: string): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x.charCodeAt(i);
    const cy = y.charCodeAt(i);
    if (cx !== cy) return fixup(cx) - fixup(cy);
  }
  return x.length - y.length;
}

// ---- relation, under, native ----

const truth = (v: unknown): Truth => (v === true || v === false ? v : undefined);

async function relation(name: unknown, run: Run): Promise<Truth> {
  if (typeof name !== 'string') return undefined;
  const { env } = run;
  const resolver = env.relation(env.ref.type, name);
  if (!resolver) return undefined;
  return truth(await resolver.holds(env.principal, env.ref, run.subject));
}

async function native(op: string, args: unknown, run: Run): Promise<Truth> {
  const { env } = run;
  const filter = env.native(op);
  if (!filter) return undefined;
  return truth(await filter.matches(args, run.subject, env.ref, env.ctx));
}

/** A fresh ref, or `undefined` when the input is not one; a null id counts as no id. */
function copyRef(r: unknown): Ref | undefined {
  if (!isObject(r)) return undefined;
  const type: unknown = r.type;
  const id: unknown = r.id;
  if (typeof type !== 'string') return undefined;
  if (id === undefined || id === null) return { type, id: undefined };
  return typeof id === 'string' ? { type, id } : undefined;
}

// Same copying and charging rule as literalList.
function copyRefs(v: unknown, run: Run): readonly Ref[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const length = v.length;
  if (!charge(run, length)) return undefined;
  const out: Ref[] = [];
  let chars = 0;
  for (let i = 0; i < length; i++) {
    const ref = copyRef(v[i]);
    if (ref === undefined) return undefined;
    chars += stringCost(ref.type, ref.id);
    out.push(ref);
  }
  return charge(run, chars) ? out : undefined;
}

async function under(raw: unknown, run: Run): Promise<Truth> {
  const scopes = copyRefs(raw, run);
  if (scopes === undefined) return undefined;
  // Agrees with F1 simplify, which turns an empty `under` into FALSE.
  if (scopes.length === 0) return false;

  const ancestors = await (run.ancestors ??= loadAncestors(run));
  // Each lookup hashes the scope's type and id, whose lengths copyRefs already charged.
  if (ancestors === undefined || !charge(run, scopes.length)) return undefined;

  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (scope.id === undefined ? ancestors.types.has(scope.type) : ancestors.keys.has(refKey(scope.type, scope.id))) return true;
  }
  return false;
}

interface AncestorIndex {
  readonly types: ReadonlySet<string>;
  readonly keys: ReadonlySet<string>;
}

// Length-prefixed rather than joined with a separator: a type may contain any character, NUL included.
const refKey = (type: string, id: string): string => `${type.length}:${type}${id}`;

/** Built once per evaluation. `undefined`: unknown resource (null), a throw, a malformed list, or no budget left to copy it. */
async function loadAncestors(run: Run): Promise<AncestorIndex | undefined> {
  const { env } = run;
  try {
    const list = copyRefs(await env.ancestors(env.ref), run);
    if (list === undefined || !charge(run, list.length)) return undefined;
    const types = new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      types.add(a.type);
      if (a.id !== undefined) keys.add(refKey(a.type, a.id));
    }
    return { types, keys };
  } catch {
    return undefined;
  }
}

// ---- matchers ----

// Tokens are code points, or one of these markers.
const ONE = -1;
const RUN = -2;
const RUN_NO_SLASH = -3;
const SLASH = 0x2f;

const overCap = (pattern: string, text: string): boolean => pattern.length * text.length > MAX_MATCH_WORK;

/** SQL LIKE, case-sensitive: `%` any run, `_` one character, `\` escapes. `undefined`: over the work cap, or a trailing `\`. */
export function matchLike(pattern: string, text: string): boolean | undefined {
  if (overCap(pattern, text)) return undefined;
  const cps = codePoints(pattern);
  const tokens: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === 0x5c) {
      if (i + 1 === cps.length) return undefined;
      tokens.push(cps[++i]);
    } else tokens.push(c === 0x25 ? RUN : c === 0x5f ? ONE : c);
  }
  return match(tokens, text);
}

/** `**` any run including `/`, `*` any run without `/`, everything else literal. `undefined`: over the work cap. */
export function matchGlob(pattern: string, text: string): boolean | undefined {
  if (overCap(pattern, text)) return undefined;
  const cps = codePoints(pattern);
  const tokens: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== 0x2a) tokens.push(cps[i]);
    else if (cps[i + 1] === 0x2a) {
      tokens.push(RUN);
      i++;
    } else tokens.push(RUN_NO_SLASH);
  }
  return match(tokens, text);
}

/** `*` any run including `/`, everything else literal. `undefined`: over the work cap. */
export function matchWildcard(pattern: string, text: string): boolean | undefined {
  if (overCap(pattern, text)) return undefined;
  return match(
    codePoints(pattern).map((c) => (c === 0x2a ? RUN : c)),
    text,
  );
}

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

// No regex built from data (ReDoS): one pass per token over the text, O(|pattern|·|text|).
function match(tokens: readonly number[], text: string): boolean {
  const t = codePoints(text);
  const n = t.length;
  let prev = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  prev[0] = 1;

  for (const token of tokens) {
    next.fill(0);
    if (token === RUN) {
      next[0] = prev[0];
      for (let j = 1; j <= n; j++) next[j] = prev[j] | next[j - 1];
    } else if (token === RUN_NO_SLASH) {
      next[0] = prev[0];
      for (let j = 1; j <= n; j++) next[j] = prev[j] | (t[j - 1] === SLASH ? 0 : next[j - 1]);
    } else if (token === ONE) {
      for (let j = 1; j <= n; j++) next[j] = prev[j - 1];
    } else {
      for (let j = 1; j <= n; j++) next[j] = t[j - 1] === token ? prev[j - 1] : 0;
    }
    [prev, next] = [next, prev];
  }
  return prev[n] === 1;
}
