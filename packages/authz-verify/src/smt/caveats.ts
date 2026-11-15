import type { Condition } from '@spinajs/authz';
import type { CaveatContext, CaveatParamType, OpaqueRef, PolicyIR } from '@spinajs/authz-ir';

import { Unsupported, and, not, or } from './formula.js';
import type { Formula, Term } from './formula.js';

/** What a solver model says about the context variables. */
export interface ContextModel {
  readonly holds: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, number>;
}

const ROOTS = new Set(['principal', 'resource', 'env', 'scope']);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const COMPARISONS = new Set(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'null']);
const ORDER: Record<string, (a: Term, b: Term) => Formula> = {
  eq: (a, b) => ({ cmp: 'eq', a, b }),
  ne: (a, b) => not({ cmp: 'eq', a, b }),
  lt: (a, b) => ({ cmp: 'lt', a, b }),
  lte: (a, b) => ({ cmp: 'le', a, b }),
  gt: (a, b) => ({ cmp: 'lt', a: b, b: a }),
  gte: (a, b) => ({ cmp: 'le', a: b, b: a }),
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Caveats as formulas over context variables (V2b): integer and real comparisons, string equality and `in` lists
 * (strings interned as integers, so string theory is not needed), booleans, timestamps as epoch milliseconds.
 * Pattern operators (`like`, `glob`, `wildcard`), `ipaddress` parameters and condition functions are uninterpreted:
 * free booleans recorded as opaque, which the evaluator re-run then decides.
 */
export class CaveatEncoder {
  /** Context variable (`c:<path>`) to its parameter type. */
  readonly params = new Map<string, CaveatParamType>();
  readonly opaque: OpaqueRef[] = [];
  private readonly strings = new Map<string, number>();
  private readonly memo = new Map<string, Formula>();
  private free = 0;

  constructor(private readonly ir: PolicyIR) {}

  /** The caveat holds for the request context. */
  formula(name: string): Formula {
    let f = this.memo.get(name);
    if (f === undefined) {
      const def = Object.prototype.hasOwnProperty.call(this.ir.caveats, name) ? this.ir.caveats[name] : undefined;
      if (def === undefined) throw new Unsupported(`caveat ${name} is not defined`);
      f = this.condition(def.expr, def.params);
      this.memo.set(name, f);
    }
    return f;
  }

  /** The request context a model stands for: every parameter a caveat read, at the model's value. */
  context(model: ContextModel): CaveatContext {
    const out: Record<string, unknown> = {};
    const codes = new Map([...this.strings].map(([s, c]) => [c, s]));
    for (const [name, type] of this.params) {
      const n = model.values.get(name) ?? 0;
      const value = type === 'bool' ? model.holds.has(name) : type === 'string' ? (codes.get(n) ?? `~${n}`) : type === 'timestamp' ? new Date(n).toISOString() : n;
      set(out, name.slice(2).split('.'), value);
    }
    return out;
  }

  private condition(c: Condition, params: Readonly<Record<string, CaveatParamType>>): Formula {
    const n = c as { readonly all?: readonly Condition[]; readonly any?: readonly Condition[]; readonly not?: Condition; readonly fn?: unknown; readonly attr?: unknown };
    if (typeof n.attr === 'string') return this.attribute(n.attr, c, params);
    if (n.all !== undefined) return and(...n.all.map((x) => this.condition(x, params)));
    if (n.any !== undefined) return or(...n.any.map((x) => this.condition(x, params)));
    if (n.not !== undefined) return not(this.condition(n.not, params));
    if (typeof n.fn === 'string') return this.uninterpreted('condition-function', n.fn);
    throw new Unsupported(`condition ${JSON.stringify(c)} has no known shape`);
  }

  private attribute(attr: string, c: Readonly<Record<string, unknown>>, params: Readonly<Record<string, CaveatParamType>>): Formula {
    const op = Object.keys(c).find((k) => k !== 'attr');
    if (op === undefined) throw new Unsupported(`condition on ${attr} has no operator`);
    if (!COMPARISONS.has(op)) return this.uninterpreted('condition-function', `${attr} ${op}`);
    const type = params[attr] ?? infer(c[op]);
    if (type === 'ipaddress') return this.uninterpreted('condition-function', `${attr} ${op}`);
    return this.comparison(attr, type, op, c[op], params);
  }

  private comparison(attr: string, type: CaveatParamType, op: string, operand: unknown, params: Readonly<Record<string, CaveatParamType>>): Formula {
    if (op === 'null') return operand === false;
    if (type === 'bool') return this.boolean(attr, op, operand);
    if (type === 'list<string>') throw new Unsupported(`list parameter ${attr}`);
    const left = this.number(attr, type);
    if (op === 'in' || op === 'nin') {
      if (!Array.isArray(operand)) throw new Unsupported(`${op} on ${attr} needs a list`);
      const any = or(...operand.map((x) => ({ cmp: 'eq' as const, a: left, b: this.literal(x, type) })));
      return op === 'in' ? any : not(any);
    }
    if (type === 'string' && op !== 'eq' && op !== 'ne') throw new Unsupported(`${op} on string ${attr}`);
    const right = isRecord(operand) && typeof operand.ref === 'string' ? this.number(operand.ref, params[operand.ref] ?? type) : this.literal(operand, type);
    return ORDER[op](left, right);
  }

  private boolean(attr: string, op: string, operand: unknown): Formula {
    if (typeof operand !== 'boolean' || (op !== 'eq' && op !== 'ne')) throw new Unsupported(`${op} on boolean ${attr}`);
    const v = { var: this.declare(attr, 'bool') };
    return operand === (op === 'eq') ? v : not(v);
  }

  private number(path: string, type: CaveatParamType): Term {
    return { num: this.declare(path, type), real: type === 'double' };
  }

  /** Registers a context variable; only `principal.*`, `resource.*`, `env.*` and `scope.*` reach a request. */
  private declare(path: string, type: CaveatParamType): string {
    const root = path.split('.')[0];
    if (!ROOTS.has(root) || path.split('.').some((s) => UNSAFE.has(s))) throw new Unsupported(`attribute ${path} is not a context path`);
    const name = `c:${path}`;
    this.params.set(name, type);
    return name;
  }

  private literal(v: unknown, type: CaveatParamType): Term {
    if (type === 'string') {
      if (typeof v !== 'string') throw new Unsupported(`string parameter compared with ${typeof v}`);
      if (!this.strings.has(v)) this.strings.set(v, this.strings.size + 1);
      return this.strings.get(v)!;
    }
    if (type === 'timestamp' && typeof v === 'string' && !Number.isNaN(Date.parse(v))) return Date.parse(v);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    throw new Unsupported(`${type} parameter compared with ${JSON.stringify(v)}`);
  }

  private uninterpreted(kind: OpaqueRef['kind'], name: string): Formula {
    if (!this.opaque.some((o) => o.kind === kind && o.name === name)) this.opaque.push({ kind, name });
    return { var: `u:${++this.free}` };
  }
}

function infer(v: unknown): CaveatParamType {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (Array.isArray(v)) return v.every((x) => typeof x === 'number') ? 'int' : 'string';
  return 'string';
}

function set(out: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let at = out;
  for (const s of path.slice(0, -1)) {
    if (!isRecord(at[s])) at[s] = {};
    at = at[s] as Record<string, unknown>;
  }
  at[path[path.length - 1]] = value;
}
