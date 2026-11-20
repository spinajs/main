import { defaultAttribute, evaluateResidual } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, Permission, Principal, ResourceRef, SubjectEnv } from '@spinajs/authz';
import type { CaveatDef } from '@spinajs/authz-ir';

import type { TupleCaveat } from '../contracts.js';

export type CaveatTruth = 'allow' | 'deny' | 'unknown';

/** What a ReBAC caveat reads besides the tuple's context: the request env and the principal. */
export interface CaveatRequest {
  readonly principal: Principal;
  readonly permission: Permission;
  readonly resource: ResourceRef;
  readonly env: Readonly<Record<string, unknown>>;
  /** Set by a type-level residual: the only caveats it may decide at its rows; any other is `unknown` there. */
  readonly decided?: readonly string[];
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function setPath(target: Readonly<Record<string, unknown>>, segments: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = segments;
  const below = target[head];
  return { ...target, [head]: rest.length === 0 ? value : setPath(isRecord(below) ? below : {}, rest, value) };
}

/**
 * `principal` and `env` with `values` laid over them by parameter path (copies; the request stays untouched). The
 * principal's identity (`type`, `id`, `authenticated`, `source`) always stays the request's, as in the IR's `asPrincipal`.
 */
export function overlayContext(req: Pick<CaveatRequest, 'principal' | 'env'>, values: Readonly<Record<string, unknown>> | undefined): { principal: Principal; env: Record<string, unknown> } {
  let principal: Readonly<Record<string, unknown>> = {};
  let env: Record<string, unknown> = { ...req.env };
  for (const [path, value] of Object.entries(values ?? {})) {
    const [root, ...rest] = path.split('.');
    if (rest.length === 0 || rest.some((s) => s === '' || UNSAFE.has(s))) continue;
    if (root === 'env') env = setPath(env, rest, value);
    else if (root === 'principal') principal = setPath({ ...req.principal, ...principal }, rest, value);
  }
  const { type, id, authenticated, source } = req.principal;
  return { principal: { ...req.principal, ...principal, type, id, authenticated, source }, env };
}

const ABSENT = Symbol('absent');
const THREW = Symbol('threw');

/**
 * The request value at a parameter path, read as the condition compiler's `readOwn` reads it: own properties only,
 * through arrays and class instances alike. ABSENT where the compiler finds nothing; THREW where a getter throws (the
 * compiler then finds nothing too, but the vote copy would fail on it).
 */
function readParam(req: Pick<CaveatRequest, 'principal' | 'env'>, path: string): unknown {
  const [root, ...rest] = path.split('.');
  let at: unknown = root === 'principal' ? req.principal : root === 'env' ? req.env : undefined;
  try {
    for (const s of rest) {
      if (UNSAFE.has(s) || at === null || typeof at !== 'object' || !Object.hasOwn(at, s)) return ABSENT;
      at = Reflect.get(at, s);
    }
  } catch {
    return THREW;
  }
  return at;
}

// What a residual's caveatInput may hold, so the vote stays under the engine's 10 000 values (`MAX_DATA_VALUES`).
const RESIDUAL_VALUES = 8_000;

const isPlain = (v: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// The engine refuses vote data nested deeper than 32 (`MAX_DATA_DEPTH`, counted from the args); a parameter value
// sits two levels down (args, caveatInput).
const MAX_VALUE_DEPTH = 30;

/**
 * How many values the engine's strict vote copy (`copyValue`) counts for `v`, visiting every array index as it does,
 * or undefined when it would not keep `v` as it is (a class instance, function, bigint, invalid Date, cycle, undefined,
 * data nested too deep) or `v` holds more than `limit`.
 */
function plainSize(v: unknown, limit: number): number | undefined {
  let n = 0;
  const walk = (x: unknown, depth: number, seen: Set<object>): boolean => {
    if (++n > limit) return false;
    if (x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return true;
    if (typeof x !== 'object' || depth > MAX_VALUE_DEPTH || seen.has(x)) return false;
    if (x instanceof Date) return !Number.isNaN(Date.prototype.getTime.call(x));
    if (!Array.isArray(x) && !isPlain(x)) return false;
    seen.add(x);
    try {
      return childrenOf(x).every((item) => walk(item, depth + 1, seen));
    } finally {
      seen.delete(x);
    }
  };
  return walk(v, 0, new Set()) ? n : undefined;
}

/** What the copy visits below an array or object: every index of an array, holes included. */
function childrenOf(x: object): unknown[] {
  if (!Array.isArray(x)) return Object.values(x);
  const items: unknown[] = x;
  return Array.from({ length: items.length }, (_, i) => (i in items ? items.at(i) : undefined));
}

function callsFunction(c: unknown): boolean {
  if (!isRecord(c)) return false;
  if (typeof c.fn === 'string') return true;
  return [c.all, c.any].some((items) => Array.isArray(items) && items.some(callsFunction)) || callsFunction(c.not);
}

/**
 * Caveats through the domain's own ConditionCompiler, so a caveat reads env and principal exactly as an ABAC condition
 * does. Anything that keeps it from an answer is `unknown`, as in the IR evaluator (`authz-ir/src/eval/caveats.ts`).
 */
export class RebacCaveats {
  constructor(private readonly defs: ReadonlyMap<string, CaveatDef>) {}

  /** The parameter paths of the caveats named, sorted. */
  paramsOf(names: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const n of names) for (const p of Object.keys(this.defs.get(n)?.params ?? {})) out.add(p);
    return [...out].sort();
  }

  /** Whether any of the caveats named calls a condition function, which may read env and principal beyond its parameters. */
  callsFunction(names: Iterable<string>): boolean {
    for (const n of names) if (callsFunction(this.defs.get(n)?.expr)) return true;
    return false;
  }

  /**
   * What a type-level residual carries for `names`: the caveats it can decide at its rows, and their parameter values.
   * A caveat that calls a condition function (which may read anything of the request), or whose parameter values
   * cannot travel in the vote unchanged or no longer fit in it, is left out, so it is `unknown` at the rows.
   */
  residualInput(names: readonly string[], req: Pick<CaveatRequest, 'principal' | 'env'>): { decided: string[]; caveatInput: Record<string, unknown> } {
    const input = new Map<string, unknown>();
    const decided: string[] = [];
    let left = RESIDUAL_VALUES;
    // What the check's compiler reads: the overlay's copies, which keep only enumerable own properties.
    const seen = overlayContext(req, {});
    for (const name of names) {
      const def = this.defs.get(name);
      if (def === undefined || callsFunction(def.expr)) continue;
      const picked = new Map<string, unknown>();
      let cost = 0;
      const measure = (path: string): boolean => {
        const v = path === 'env.now' || input.has(path) ? ABSENT : readParam(seen, path);
        if (v === ABSENT) return true;
        const size = v === THREW || v === undefined ? undefined : plainSize(v, left - cost);
        if (size === undefined) return false;
        picked.set(path, v);
        cost += size;
        return true;
      };
      let fits: boolean;
      try {
        fits = Object.keys(def.params).every(measure);
      } catch {
        // A getter inside the value threw: the vote copy would fail on it too.
        fits = false;
      }
      if (!fits) continue;
      for (const [path, v] of picked) input.set(path, v);
      left -= cost;
      decided.push(name);
    }
    return { decided, caveatInput: Object.fromEntries(input) };
  }

  async evaluate(caveat: TupleCaveat, req: CaveatRequest, ctx: EvaluationContext): Promise<{ truth: CaveatTruth; cacheable: boolean }> {
    const def = this.defs.get(caveat.name);
    if (def === undefined) return { truth: 'unknown', cacheable: true };
    if (req.decided !== undefined && !req.decided.includes(caveat.name)) return { truth: 'unknown', cacheable: false };
    // A stored context cannot move the clock, whatever store it came from.
    const context = Object.fromEntries(Object.entries(caveat.context ?? {}).filter(([path]) => path !== 'env.now'));
    const { principal, env } = overlayContext(req, context);
    const request: DecisionRequest = { principal, actor: principal, permission: req.permission, resource: req.resource, env };
    try {
      const { filter, cacheable } = await ctx.conditions.compile(def.expr, request, ctx);
      const subjectEnv: SubjectEnv = { principal, ref: req.resource, attribute: defaultAttribute, relation: () => undefined, ancestors: () => Promise.resolve(null), native: () => undefined, ctx };
      const truth = await evaluateResidual(filter, {}, subjectEnv);
      return { truth: truth === undefined ? 'unknown' : truth ? 'allow' : 'deny', cacheable };
    } catch (e) {
      ctx.trace({ step: 'caveat', note: `${caveat.name}: ${e instanceof Error ? e.message : String(e)}` });
      return { truth: 'unknown', cacheable: false };
    }
  }
}
