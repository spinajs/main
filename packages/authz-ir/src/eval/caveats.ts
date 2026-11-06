import { DefaultConditionCompiler, defaultAttribute, evaluateResidual } from '@spinajs/authz';
import type { ConditionFunction, DecisionRequest, EvaluationContext, Permission, PermissionRegistry, Principal, ResourceRef, SubjectEnv } from '@spinajs/authz';

import type { ObjectRef, PolicyIR, PrincipalFacts } from '../ir.js';
import type { Truth } from './explain.js';

/**
 * Caveat context, read the way the engine reads a request: `principal.*` from the principal facts (overlaid by
 * `principal`), `resource.*` from `resource` (the row), `env.*` from `env` (plus `now`), `scope.<type>.*` from `scope`.
 */
export interface CaveatContext {
  principal?: Readonly<Record<string, unknown>>;
  resource?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, unknown>>;
  scope?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface CaveatInput {
  principal: PrincipalFacts;
  permission: Permission;
  resource: ObjectRef;
  context?: CaveatContext;
  at: Date;
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Evaluates a caveat with the engine's own `DefaultConditionCompiler` and `evaluateResidual`, so the answer is
 * the one the engine gives: anything missing from the context, a condition function that is not registered and
 * a scope attribute that cannot be read are all `unknown`.
 */
export class CaveatEvaluator {
  private readonly compiler: DefaultConditionCompiler;

  constructor(
    private readonly ir: PolicyIR,
    functions?: readonly ConditionFunction[],
  ) {
    this.compiler = new DefaultConditionCompiler(functions);
  }

  /** `tupleContext` comes from a conditional tuple and is keyed by parameter path (`'resource.status'`); it wins over the request context. */
  async evaluate(name: string, input: CaveatInput, tupleContext?: Readonly<Record<string, unknown>>): Promise<Truth> {
    if (!own(this.ir.caveats, name)) return 'unknown';
    try {
      const context = withTupleContext(input.context ?? {}, tupleContext);
      const principal = asPrincipal(input.principal, context.principal);
      const subject = isRecord(context.resource) ? context.resource : {};
      const resource: ResourceRef = { type: input.resource.type, id: input.resource.id };
      const req: DecisionRequest = { principal, actor: principal, permission: input.permission, resource, subject, env: isRecord(context.env) ? context.env : {} };
      const ctx = evaluationContext(input.at, isRecord(context.scope) ? context.scope : {}, this.compiler);
      const { filter } = await this.compiler.compile(this.ir.caveats[name].expr, req, ctx);
      const env: SubjectEnv = { principal, ref: resource, attribute: defaultAttribute, relation: () => undefined, ancestors: () => Promise.resolve(null), native: () => undefined, ctx };
      const truth = await evaluateResidual(filter, subject, env);
      return truth === undefined ? 'unknown' : truth ? 'allow' : 'deny';
    } catch {
      return 'unknown';
    }
  }
}

function asPrincipal(facts: PrincipalFacts, overlay: unknown): Principal {
  const extra = isRecord(overlay) ? overlay : {};
  const attributes = { ...(facts.attributes ?? {}), ...(isRecord(extra.attributes) ? extra.attributes : {}) };
  return { ...extra, type: facts.type, id: facts.id, authenticated: true, source: 'authz-ir', attributes };
}

function withTupleContext(context: CaveatContext, tuple: Readonly<Record<string, unknown>> | undefined): CaveatContext {
  if (tuple === undefined) return context;
  const out = structuredClone(context) as Record<string, unknown>;
  for (const [path, value] of Object.entries(tuple)) {
    const segments = path.split('.');
    if (segments.some((s) => UNSAFE.has(s))) continue;
    let at = out;
    for (const s of segments.slice(0, -1)) {
      if (!isRecord(at[s])) at[s] = {};
      at = at[s] as Record<string, unknown>;
    }
    at[segments[segments.length - 1]] = value;
  }
  return out;
}

/** What the compiler reads from a request context: the clock and scope attributes (one node per scope type). */
function evaluationContext(now: Date, scope: Readonly<Record<string, Readonly<Record<string, unknown>>>>, conditions: DefaultConditionCompiler): EvaluationContext {
  const scopeTypes = Object.keys(scope);
  return {
    domain: 'authz-ir',
    now,
    permissions: undefined as unknown as PermissionRegistry,
    ancestors: () => Promise.resolve(scopeTypes.map((type) => ({ type, id: type }))),
    attributes: (ref) => Promise.resolve(own(scope, ref.type) && isRecord(scope[ref.type]) ? scope[ref.type] : null),
    conditions,
    relation: () => undefined,
    check: () => Promise.reject(new Error('caveats do not run nested checks')),
    cache: new Map(),
    trace: () => undefined,
  };
}
