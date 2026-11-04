import { quote } from '@spinajs/util';
import { AuthzConfigError } from '../../contracts/errors.js';
import { compareDenyReasons } from '../../contracts/decision.js';
import type { AccessPlan, ListPlanRequest, ModelListPlan } from '../../contracts/plan.js';
import type { AuthorizationModel } from '../../contracts/model.js';
import type { PermissionDef } from '../../contracts/permission.js';
import type { Principal, ResourceType } from '../../contracts/principal.js';
import { principalState } from '../cache-key.js';
import { ModelContext, l1Key } from '../context.js';
import type { Delegation } from '../delegation.js';
import { combinePlans, nonePlan, readModelPlan, withinOf, CEILING_DENIAL } from '../plan.js';
import type { PlanAnswer } from '../plan.js';
import { settleWithin } from '../run.js';
import { describeError } from '../vote.js';
import { hostFor } from '../context/host.js';
import { relation } from '../context/request.js';
import { ceilingOf } from '../pipeline/delegate.js';
import { admits, contextCacheKey, principalCacheId } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import { CachedPlan } from '../types.js';
import type { Engine, Run } from '../types.js';

/** undefined when nothing may be cached for this call (a model version() that fails, a principal without canonical state). */
export function planKey(engine: Engine, principal: Principal, def: PermissionDef, type: ResourceType, run: Run): string | undefined {
  if (run.versions === undefined) return undefined;
  const state = principalState(principal);
  return state === undefined ? undefined : l1Key('plan', engine.domain, JSON.stringify([state, def.name, type, run.versions]));
}

export function cachedPlan(engine: Engine, key: string, run: Run): AccessPlan | undefined {
  const entry = run.scope.get(key);
  if (!(entry instanceof CachedPlan) || entry.generation !== engine.generation) return undefined;
  const until = entry.plan.kind === 'filter' ? entry.plan.validUntil : undefined;
  return until !== undefined && until.getTime() <= run.instant.getTime() ? undefined : entry.plan;
}

export async function buildPlan(engine: Engine, d: Delegation, def: PermissionDef, type: ResourceType, env: Readonly<Record<string, unknown>>, run: Run): Promise<{ readonly plan: AccessPlan; readonly faulted: boolean }> {
  const ceiling = ceilingOf(d, def, { type }, undefined, run.instant);
  if (ceiling.denials.length > 0) return { plan: nonePlan([...ceiling.denials].sort(compareDenyReasons)[0]), faulted: false };
  const within = withinOf(ceiling.restrict);
  if (within === null) return { plan: nonePlan(CEILING_DENIAL), faulted: false };
  const route = engine.table.get(def.name, type) ?? { algorithm: 'deny-overrides', models: [] };
  if (route.algorithm !== 'deny-overrides') throw new AuthzConfigError(`${engine.where}: list permission ${quote(def.name)} is routed on type ${quote(type)} with ${quote(route.algorithm)}; access plans combine with deny-overrides only (boot rule 12)`);
  const runAs = d.principal;
  const fresh = run.fresh === true ? { fresh: true } : {};
  const req: ListPlanRequest = Object.freeze(d.actor === undefined ? { principal: runAs, permission: def, type, env, ...fresh } : { principal: runAs, actor: d.actor, permission: def, type, env, ...fresh });
  const host = hostFor(engine, run);
  const cacheId = principalCacheId(runAs);
  const label = `${def.name} on ${quote(type)}`;
  const answers = await Promise.all(route.models.filter((m) => admits(m, runAs)).map((m) => modelPlan(engine, m, req, new ModelContext(host, m.name, run.scope, run.instant, 0, undefined, contextCacheKey(m.name, cacheId, 'listPlan')), label)));
  const bounds = { ...(within ? { within } : {}), ...(ceiling.expiresAt ? { validUntil: ceiling.expiresAt } : {}) };
  return { plan: combinePlans(answers, bounds), faulted: answers.some((a) => a.faulted) || run.nested.faulted };
}

/** A failure, a timeout, a ctx fault or a malformed plan is a deny-all with model_error: fail closed like an indeterminate vote (B04). */
export async function modelPlan(engine: Engine, model: AuthorizationModel, req: ListPlanRequest, ctx: ModelContext, label: string): Promise<PlanAnswer & { readonly faulted: boolean }> {
  let support: unknown;
  try {
    support = typeof model.listSupport === 'function' ? model.listSupport(req.permission, req.type, { relation: (type, name) => relation(engine, type, name) }) : undefined;
  } catch (e) {
    throw new AuthzConfigError(`${engine.where}: model ${quote(model.name)} threw from listSupport() for ${label}: ${describeError(e)}`, { cause: e });
  }
  if (support !== true || typeof model.listPlan !== 'function') throw new AuthzConfigError(`${engine.where}: model ${quote(model.name)} cannot plan lists of ${label} (boot rule 12)`);
  const settled = await settleWithin(
    Promise.resolve().then(() => model.listPlan!(req, ctx)),
    engine.config.modelTimeoutMs,
    describeError,
    'listPlan',
  );
  let fault: string | undefined;
  let plan: ModelListPlan | undefined;
  if (!settled.ok) fault = settled.error;
  else if (ctx.fault !== undefined) fault = ctx.fault;
  else {
    try {
      plan = readModelPlan(settled.value);
    } catch (e) {
      fault = `listPlan returned a malformed plan: ${describeError(e)}`;
    }
  }
  if (plan !== undefined) return { model: model.name, plan, faulted: false };
  logAt(engine, 'error', { model: model.name, check: label, cause: fault }, 'Authz domain ${domain}: model ${model} failed to plan ${check}: ${cause}');
  ctx.detachMemo();
  return { model: model.name, plan: Object.freeze({ kind: 'deny-all', reason: Object.freeze({ code: 'model_error', model: model.name }) }), faulted: true };
}
