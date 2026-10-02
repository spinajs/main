import { FALSE, TRUE, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { DenyReason, FieldSet, TraceStep, Vote } from '../contracts/decision.js';
import type { ResourceRef } from '../contracts/principal.js';

const MAX_FILTER_DEPTH = 256;
const MAX_DATA_DEPTH = 32;
/**
 * Budgets on expanded size: a DAG of shared subtrees (easy to build with the
 * contract and/or) is a tree of exponential size to every walk after this one
 * (simplify, bindRefs, evaluateResidual, SQL compilers), and none of them can
 * be timed out. Copying within a budget makes every later walk linear.
 */
export const MAX_FILTER_NODES = 10_000;
export const MAX_DATA_VALUES = 10_000;
export const MAX_TRACE_STEPS = 1_000;
const VALUES_OVER = 'the data holds more than the budget of values';
const STRUCTURAL = new Set(['true', 'false', 'and', 'or', 'not']);
const CMP_OPS = new Set(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null', 'notnull']);

export class VoteFault extends Error {}

class DataOverflow extends Error {}

/** Nodes (filters) or values (data) a copy may still produce. */
export interface Budget {
  left: number;
}

export const budget = (n: number): Budget => ({ left: n });

/** Which non-structural ops a filter may hold; `'*'` = any well-formed op. */
export type OpPolicy = ReadonlySet<string> | '*';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

const isPlain = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

export const describeError = (e: unknown): string => {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return typeof e === 'string' ? e : Object.prototype.toString.call(e);
  } catch {
    return 'unprintable error';
  }
};

export function faultVote(model: string, error: string): Vote {
  return Object.freeze({ model, permitWhen: FALSE, denyWhen: TRUE, error, cacheable: false });
}

/**
 * The engine's own deep-frozen copy of a model's vote; any fault yields an
 * indeterminate vote (B04). Never passes a model's object through.
 */
export function sanitizeVote(raw: unknown, model: string, capabilities: { readonly effects?: unknown; readonly residuals?: unknown }): Vote {
  try {
    if (!isObject(raw)) throw new VoteFault(`vote is not an object (${raw === null ? 'null' : typeof raw})`);
    if (raw.error !== undefined) return faultVote(model, `model reported an error: ${describeError(raw.error)}`);

    const ops = new Set(Array.isArray(capabilities.residuals) ? capabilities.residuals.filter((o): o is string => typeof o === 'string') : []);
    const effects = Array.isArray(capabilities.effects) ? capabilities.effects : [];

    // One node budget for every filter of the vote and one value budget for all its data:
    // per-copy budgets would multiply when many nodes share one object.
    const nodes = budget(MAX_FILTER_NODES);
    const values = budget(MAX_DATA_VALUES);
    const permitWhen = simplify(sanitizeFilter(raw.permitWhen, ops, 'permitWhen', nodes, values));
    const denyWhen = simplify(sanitizeFilter(raw.denyWhen, ops, 'denyWhen', nodes, values));
    if (permitWhen !== FALSE && !effects.includes('permit')) throw new VoteFault("permitWhen is not FALSE but capabilities.effects lacks 'permit'");
    if (denyWhen !== FALSE && !effects.includes('deny')) throw new VoteFault("denyWhen is not FALSE but capabilities.effects lacks 'deny'");

    const vote: { -readonly [K in keyof Vote]: Vote[K] } = { model, permitWhen, denyWhen, cacheable: raw.cacheable === true };
    if (raw.denies !== undefined) vote.denies = sanitizeDenies(raw.denies, ops, nodes, values);
    if (raw.reason !== undefined) vote.reason = sanitizeReason(raw.reason, 'reason', values);
    if (raw.roles !== undefined) vote.roles = sanitizeRoles(raw.roles, values);
    if (raw.fields !== undefined) vote.fields = sanitizeFields(raw.fields, values);
    if (raw.validUntil !== undefined) {
      const until = validDate(raw.validUntil);
      // An unreadable expiry must not let the decision outlive it in a cache.
      if (until === undefined) vote.cacheable = false;
      else vote.validUntil = until;
    }
    if (raw.trace !== undefined) {
      const trace = sanitizeTrace(raw.trace, model, values);
      if (trace !== undefined) vote.trace = trace;
    }
    return Object.freeze(vote);
  } catch (e) {
    return faultVote(model, e instanceof VoteFault ? `malformed vote: ${e.message}` : `malformed vote: ${describeError(e)}`);
  }
}

/** Validates and copies a filter into a fresh frozen tree (not simplified) of at most `nodes.left` nodes. */
export function sanitizeFilter(f: unknown, ops: OpPolicy, where: string, nodes: Budget, values: Budget, depth = 1): ResourceFilter {
  if (depth > MAX_FILTER_DEPTH) throw new VoteFault(`${where} is nested deeper than ${MAX_FILTER_DEPTH}`);
  spend(nodes, where);
  if (!isObject(f)) throw new VoteFault(`${where} is not a filter`);
  const op = f.op;
  if (typeof op !== 'string') throw new VoteFault(`${where} has no string op`);
  if (!STRUCTURAL.has(op)) {
    const known = op === 'cmp' || op === 'relation' || op === 'under' || (op.startsWith('native:') && op.length > 'native:'.length);
    if (!known) throw new VoteFault(`${where} holds unknown op ${JSON.stringify(op)}`);
    if (ops !== '*' && !ops.has(op)) throw new VoteFault(`${where} holds op ${JSON.stringify(op)}, which capabilities.residuals does not declare`);
  }

  switch (op) {
    case 'true':
      return TRUE;
    case 'false':
      return FALSE;
    case 'and':
    case 'or': {
      const args = f.args;
      if (!Array.isArray(args)) throw new VoteFault(`${where}: ${op} without an args array`);
      const out: ResourceFilter[] = [];
      for (let i = 0; i < args.length; i++) {
        if (!(i in args)) throw new VoteFault(`${where}: ${op} with a hole in args`);
        out.push(sanitizeFilter(args[i], ops, where, nodes, values, depth + 1));
      }
      return Object.freeze({ op, args: Object.freeze(out) });
    }
    case 'not':
      return Object.freeze({ op, arg: sanitizeFilter(f.arg, ops, where, nodes, values, depth + 1) });
    case 'cmp': {
      const { field, cmp } = f;
      if (typeof field !== 'string') throw new VoteFault(`${where}: cmp without a string field`);
      if (typeof cmp !== 'string' || !CMP_OPS.has(cmp)) throw new VoteFault(`${where}: unknown cmp ${JSON.stringify(cmp)}`);
      const node: Record<string, unknown> = { op, field, cmp };
      if (f.value !== undefined) node.value = sanitizeValue(f.value, where, nodes);
      return Object.freeze(node) as ResourceFilter;
    }
    case 'relation':
      if (typeof f.relation !== 'string') throw new VoteFault(`${where}: relation without a string name`);
      return Object.freeze({ op, relation: f.relation });
    case 'under': {
      const scopes = f.scopes;
      if (!Array.isArray(scopes)) throw new VoteFault(`${where}: under without a scopes array`);
      const out: ResourceRef[] = [];
      for (let i = 0; i < scopes.length; i++) {
        spend(nodes, where);
        const ref = i in scopes ? copyRef(scopes[i]) : undefined;
        if (ref === undefined) throw new VoteFault(`${where}: under with a malformed scope`);
        out.push(ref);
      }
      return Object.freeze({ op, scopes: Object.freeze(out) });
    }
    default: {
      const node: Record<string, unknown> = { op };
      if (f.args !== undefined) node.args = copyData(f.args, true, values);
      return Object.freeze(node) as ResourceFilter;
    }
  }
}

function spendValues(values: Budget, n: number): void {
  values.left -= n;
  if (values.left < 0) throw new VoteFault(VALUES_OVER);
}

function spend(nodes: Budget, where: string): void {
  if (--nodes.left < 0) throw new VoteFault(`${where}: the filters hold more than the budget of nodes`);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeValue(v: unknown, where: string, nodes: Budget): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || isFiniteNumber(v)) return v;
  if (Array.isArray(v)) {
    const out: (string | number)[] = [];
    for (let i = 0; i < v.length; i++) {
      spend(nodes, where);
      const item = i in v ? v[i] : undefined;
      if (typeof item !== 'string' && !isFiniteNumber(item)) throw new VoteFault(`${where}: cmp list holds a value that is neither a string nor a finite number`);
      out.push(item);
    }
    return Object.freeze(out);
  }
  if (isObject(v) && isPlain(v) && Object.keys(v).length === 1 && Object.hasOwn(v, 'ref') && typeof v.ref === 'string') return Object.freeze({ ref: v.ref });
  throw new VoteFault(`${where}: cmp value is not a literal (string, finite number, boolean, null, list) or a { ref }`);
}

/** A frozen `{ type, id? }` copy, or undefined when not ref-shaped (`id: null` = no id). */
export function copyRef(v: unknown): ResourceRef | undefined {
  if (!isObject(v) || typeof v.type !== 'string' || v.type === '') return undefined;
  const id = v.id;
  if (id === undefined || id === null) return Object.freeze({ type: v.type });
  return typeof id === 'string' ? Object.freeze({ type: v.type, id }) : undefined;
}

function sanitizeDenies(v: unknown, ops: OpPolicy, nodes: Budget, values: Budget): Vote['denies'] {
  if (!Array.isArray(v)) throw new VoteFault('denies is not an array');
  if (v.length > MAX_FILTER_NODES) throw new VoteFault('denies has more entries than the budget of nodes');
  const out: { readonly when: ResourceFilter; readonly reason: DenyReason }[] = [];
  for (let i = 0; i < v.length; i++) {
    const entry = i in v ? v[i] : undefined;
    if (!isObject(entry)) throw new VoteFault(`denies[${i}] is not an object`);
    out.push(Object.freeze({ when: simplify(sanitizeFilter(entry.when, ops, `denies[${i}].when`, nodes, values)), reason: sanitizeReason(entry.reason, `denies[${i}].reason`, values) }));
  }
  return Object.freeze(out);
}

function sanitizeReason(v: unknown, where: string, values: Budget): DenyReason {
  if (!isObject(v) || !isPlain(v) || typeof v.code !== 'string' || v.code === '') throw new VoteFault(`${where} is not a deny reason with a string code`);
  return copyData(v, true, values) as DenyReason;
}

function sanitizeRoles(v: unknown, values: Budget): Readonly<Record<string, string>> {
  if (!isObject(v) || !isPlain(v)) throw new VoteFault('roles is not a plain object');
  const out: Record<string, string> = {};
  for (const k of Object.keys(v)) {
    if (typeof v[k] !== 'string') throw new VoteFault(`roles.${k} is not a string`);
    spendValues(values, 1);
    define(out, k, v[k]);
  }
  return Object.freeze(out);
}

function sanitizeFields(v: unknown, values: Budget): FieldSet {
  if (!isObject(v)) throw new VoteFault('fields is not an object');
  const out: { -readonly [K in keyof FieldSet]: FieldSet[K] } = {};
  for (const key of ['read', 'write', 'hide'] as const) {
    const list = v[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new VoteFault(`fields.${key} is not a list of strings`);
    spendValues(values, list.length);
    for (let i = 0; i < list.length; i++) if (!(i in list) || typeof list[i] !== 'string') throw new VoteFault(`fields.${key} is not a list of strings`);
    out[key] = Object.freeze([...(list as string[])]);
  }
  return Object.freeze(out);
}

function sanitizeTrace(v: unknown, model: string, values: Budget): readonly TraceStep[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TraceStep[] = [];
  for (let i = 0; i < v.length && i < MAX_TRACE_STEPS; i++) {
    const s: unknown = v[i];
    if (!isObject(s) || typeof s.step !== 'string' || typeof s.note !== 'string') continue;
    out.push(traceStep(model, s, values));
  }
  return Object.freeze(out);
}

/** `by` is always the recorder's, never the caller's. */
export function traceStep(by: string, s: { readonly step?: unknown; readonly note?: unknown; readonly data?: unknown }, values?: Budget): TraceStep {
  const step: { -readonly [K in keyof TraceStep]: TraceStep[K] } = { by, step: String(s.step), note: String(s.note) };
  if (s.data !== undefined) {
    let data: unknown;
    try {
      data = copyData(s.data, false, values);
    } catch {
      data = undefined;
    }
    if (data !== undefined) step.data = data;
  }
  return Object.freeze(step);
}

export function validDate(v: unknown): Date | undefined {
  if (!(v instanceof Date)) return undefined;
  let t: number;
  try {
    t = Date.prototype.getTime.call(v);
  } catch {
    return undefined;
  }
  return Number.isNaN(t) ? undefined : Object.freeze(new Date(t));
}

/**
 * Deep frozen copy of plain data: primitives, Dates, arrays, plain objects.
 * Other values (functions, class instances, symbols, bigints, cycles, too deep)
 * throw when `strict`, else become undefined. Values are charged to `values`
 * (a fresh MAX_DATA_VALUES when absent); past it strict throws, else the whole
 * copy is undefined.
 */
export function copyData(v: unknown, strict: boolean, values: Budget = budget(MAX_DATA_VALUES)): unknown {
  try {
    return copyValue(v, 0, new Set(), strict, values);
  } catch (e) {
    if (!(e instanceof DataOverflow)) throw e;
    if (strict) throw new VoteFault(VALUES_OVER);
    return undefined;
  }
}

function copyValue(v: unknown, depth: number, path: Set<object>, strict: boolean, values: Budget): unknown {
  if (--values.left < 0) throw new DataOverflow();
  const reject = (why: string): undefined => {
    if (strict) throw new VoteFault(why);
    return undefined;
  };
  if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v !== 'object') return reject(`unsupported ${typeof v} value`);
  if (depth > MAX_DATA_DEPTH) return reject('data nested too deep');
  if (v instanceof Date) return validDate(v) ?? reject('invalid Date');
  if (path.has(v)) return reject('cyclic data');
  path.add(v);
  try {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) out.push(copyValue(i in v ? v[i] : undefined, depth + 1, path, strict, values));
      return Object.freeze(out);
    }
    if (!isPlain(v)) return reject('class instance in data');
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const item = copyValue((v as Record<string, unknown>)[k], depth + 1, path, strict, values);
      if (item !== undefined) define(out, k, item);
    }
    return Object.freeze(out);
  } finally {
    path.delete(v);
  }
}

// defineProperty: a '__proto__' key from parsed JSON stays an own data key instead of hitting the setter.
function define(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
}

export function deepFreeze<T>(v: T, seen = new Set<unknown>()): T {
  if (v === null || typeof v !== 'object' || seen.has(v)) return v;
  seen.add(v);
  for (const x of Object.values(v as object)) deepFreeze(x, seen);
  return Object.freeze(v);
}
