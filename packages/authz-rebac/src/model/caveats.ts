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

/** The request values of `paths` (`env.*` but `env.now`, `principal.*`), for a residual that is evaluated later. */
export function pickCaveatInput(paths: readonly string[], req: Pick<CaveatRequest, 'principal' | 'env'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const roots: Record<string, unknown> = { principal: req.principal, env: req.env };
  for (const path of paths) {
    if (path === 'env.now') continue;
    let at: unknown = roots;
    for (const s of path.split('.')) at = isRecord(at) && Object.hasOwn(at, s) ? at[s] : undefined;
    if (at !== undefined) out[path] = at;
  }
  return out;
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

  async evaluate(caveat: TupleCaveat, req: CaveatRequest, ctx: EvaluationContext): Promise<{ truth: CaveatTruth; cacheable: boolean }> {
    const def = this.defs.get(caveat.name);
    if (def === undefined) return { truth: 'unknown', cacheable: true };
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
