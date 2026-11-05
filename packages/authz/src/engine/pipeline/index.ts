import { quote } from '@spinajs/util';
import { Perf } from '@spinajs/log-common';
import { AuthzConfigError } from '../../contracts/errors.js';
import { TRUE } from '../../contracts/filter.js';
import type { TraceStep } from '../../contracts/decision.js';
import { principalKey } from '../../contracts/principal.js';
import type { Principal, PrincipalRef, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import type { CheckInput } from '../../contracts/service.js';
import { decisionKey } from '../cache-key.js';
import { isObject } from '../internal/util.js';
import type { Pipeline } from '../run.js';
import { cached } from '../cache/lookup.js';
import { tagsOf } from '../cache/store.js';
import { ancestorsOf } from '../context/scope.js';
import { refuseLateType, requirePermission } from '../context/late-type.js';
import { once } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import { CORE, GLOBAL_TYPE, NO_ROLES, SYSTEM_REF } from '../types.js';
import type { Checked, Engine, Gate, Parties, Run } from '../types.js';
import { delegationOf, partiesOf } from './delegate.js';
import { finish } from './finish.js';
import { coreDenial, partiesDenial, principalGate } from './principal-gate.js';
import { resolveResource } from './resolve.js';
import { combineVotes, conclude, fieldsStep, reasonStep, vote } from './steps.js';
import type { Admitted, Core, Head } from './steps.js';

/** A ref (and subject) the caller already resolved, so no adapter sees it again. */
export interface Resolved {
  readonly ref: ResourceRef;
  readonly subject: unknown;
}

type RunGate = Extract<Gate, { readonly kind: 'run' }>;

/** The check pipeline (design §10.1); every step below runs in this order. */
export function* pipeline(engine: Engine, input: CheckInput, run: Run, resolved?: Resolved): Pipeline<Checked> {
  const head = yield* prepare(engine, input, run, resolved);
  const gate = principalGate(input.principal);
  if (gate.kind !== 'run') return gateExit(engine, head, gate);
  const admitted = yield* admit(engine, head, input, gate);
  if ('decision' in admitted) return admitted;
  const voted = yield* vote(engine, admitted, input);
  const combination = yield* combineVotes(engine, voted, input);
  const fields = yield* fieldsStep(engine, voted, combination);
  const reason = yield* reasonStep(engine, voted, combination, fields);
  return conclude(engine, voted, combination, fields, reason);
}

// Engine-owned data goes in as is (frozen with the trace), so a deep residual is never cut.
const tracer =
  (steps: TraceStep[] | undefined): Core =>
  (step, note, data) =>
    steps?.push(data === undefined ? { by: CORE, step, note } : { by: CORE, step, note, data });

/** The permission, the resource and its route. */
function* prepare(engine: Engine, input: CheckInput, run: Run, resolved: Resolved | undefined): Pipeline<Head> {
  const started = performance.now();
  if (!isObject(input)) throw new AuthzConfigError(`${engine.where}: check input must be an object`);
  const explain = run.depth === 0 && input.explain === true;
  if (explain) run = { ...run, bypass: true };
  const steps: TraceStep[] | undefined = explain || engine.config.explain ? [] : undefined;
  const core = tracer(steps);

  const def = requirePermission(engine, input.permission);
  if (input.fresh !== undefined && typeof input.fresh !== 'boolean') throw new AuthzConfigError(`${engine.where}: fresh must be a boolean`);
  if (input.fresh === true || def.consistency === 'fresh') run = { ...run, fresh: true };
  const { ref, subject } = resolved ?? (yield* resolveResource(engine, input.resource, input.subject, def));
  refuseLateType(engine, ref.type);
  if (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type)) {
    throw new AuthzConfigError(`${engine.where}: permission ${quote(def.name)} is checked on type ${quote(ref.type)}, which is not in its types (${def.types.join(', ')}) or $global`);
  }
  core('resource', resourceKey(ref));
  const plan = engine.table.get(def.name, ref.type) ?? { algorithm: 'deny-overrides', models: [] };
  return { run, explain, steps, core, def, ref, subject, plan, base: { def, ref, algorithm: plan.algorithm, run, explain, steps, started } };
}

function gateExit(engine: Engine, head: Head, gate: Exclude<Gate, RunGate>): Checked {
  if (gate.kind === 'system') {
    head.core('principal', 'SYSTEM: allowed without models');
    return { decision: finish(engine, { ...head.base, requester: SYSTEM_REF, system: true }, { principal: SYSTEM_REF, residual: TRUE, roles: NO_ROLES, fields: engine.allFields, models: [], votes: [] }), uncacheable: true, faulted: false, ...(head.run.firm ? { firmFields: engine.allFields } : {}) };
  }
  head.core('principal', `denied before the models: ${gate.reason.code}`);
  return { decision: finish(engine, { ...head.base, requester: gate.principal }, coreDenial(gate.principal, gate.reason)), uncacheable: false, faulted: false };
}

/** Delegation, the decision key, the ancestors and the cache lookup: a decision when one of them settles the check. */
function* admit(engine: Engine, head: Head, input: CheckInput, gate: RunGate): Pipeline<Admitted | Checked> {
  const { run, ref, core, base } = head;
  const requester = gate.ref;
  const actor = input.actor;
  // Before the resource step, so a chain deeper than maxDelegation throws whatever the resource.
  const delegation = delegationOf(engine, gate.principal, actor, run.delegationBudget);
  // Undefined for a forbidden or unreadable delegate: no model runs, so the denial names the requester.
  const parties = delegation.denial ? undefined : partiesOf(delegation, gate.principal, requester);
  const key = keyOf(engine, head, gate.principal, actor, parties, requester);

  let ancestors: readonly ResourceRef[] | undefined;
  if (ref.id !== undefined) {
    const list = (yield ancestorsOf(engine, ref, run.scope)) as readonly ResourceRef[] | null;
    if (list === null) {
      core('resource', 'unknown resource: ancestors answered null');
      // No revocation tag reaches a resource that does not exist yet: a decision resting on this one is not cached.
      if (run.depth > 0) run.nested.uncacheable = true;
      return { decision: finish(engine, { ...base, requester }, parties ? partiesDenial(parties, { code: 'unknown_resource' }) : coreDenial(requester, { code: 'unknown_resource' })), uncacheable: false, faulted: false };
    }
    ancestors = list;
  }

  if (!parties) {
    core('delegation', 'denied before the models: a forbidden or unreadable delegate');
    return { decision: finish(engine, { ...base, requester }, coreDenial(requester, delegation.denial!)), uncacheable: false, faulted: false };
  }

  // Step 6.
  const principals: Principal[] = [gate.principal, ...delegation.chain];
  if (actor !== undefined) principals.push(actor);
  if (delegation.actor !== undefined) principals.push(delegation.actor);
  const tags = once(() => tagsOf(engine, head.plan.models, principals, ref, ancestors, run));
  if (key !== undefined && run.firm !== true && run.fresh !== true) {
    const hit = cached(engine, key, run, head.def, ref, requester, parties.ref);
    if (hit) return hit;
    Perf.count('authz.cache.miss');
  }
  return { ...head, principal: gate.principal, requester, delegation, parties, key, ancestors, tags };
}

/** Step 6's key, in the same synchronous stretch as the delegation: the caller may change the principal while a step waits. */
function keyOf(engine: Engine, head: Head, principal: Principal, actor: Principal | undefined, parties: Parties | undefined, requester: PrincipalRef): string | undefined {
  const { run, def, ref } = head;
  const keyed = parties !== undefined && head.subject === undefined && !run.bypass && run.versions !== undefined;
  const key = keyed ? decisionKey({ domain: engine.domain, principal, actor, permission: def.name, ref, versions: run.versions }) : undefined;
  if (keyed && key === undefined) logAt(engine, 'debug', { permission: def.name, principal: principalKey(requester) }, 'Authz domain ${domain}: ${permission} for ${principal} is not cached: the principal or actor has no canonical state');
  return key;
}
