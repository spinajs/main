import { AuthzConfigError } from '../../contracts/errors.js';
import type { PermissionDef } from '../../contracts/permission.js';
import type { Principal, PrincipalRef, ResourceRef } from '../../contracts/principal.js';
import { ceilingOutcome, mergeCeilings } from '../ceiling.js';
import type { CeilingOutcome } from '../ceiling.js';
import { resolveDelegation } from '../delegation.js';
import type { Delegation } from '../delegation.js';
import { isObject } from '../internal/util.js';
import { principalCacheId, principalRef } from '../support/misc.js';
import type { Engine, Parties, Checked, Run } from '../types.js';
import type { CheckInput } from '../../contracts/service.js';
import type { Pipeline } from '../run.js';
import { pipeline } from './index.js';

/** Throws AuthzConfigError for a malformed actor and for a chain deeper than the budget or with a cycle (B08). */
export function delegationOf(engine: Engine, principal: Principal, actor: unknown, budget: number): Delegation {
  if (actor !== undefined && (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string')) throw new AuthzConfigError(`${engine.where}: actor must be a principal`);
  try {
    return resolveDelegation(principal, actor as Principal | undefined, budget);
  } catch (e) {
    if (e instanceof AuthzConfigError) throw new AuthzConfigError(`${engine.where}: ${e.message}`, { cause: e });
    throw e;
  }
}

/** Who the models run with: under inherit the narrowed delegate (a frozen copy), else the request principal. */
export function partiesOf(d: Delegation, requestPrincipal: Principal, requester: PrincipalRef): Parties {
  const ref = d.principal === requestPrincipal ? requester : principalRef(d.principal);
  const cacheId = principalCacheId(d.principal);
  if (d.actor === undefined) return { principal: d.principal, ref, cacheId };
  return { principal: d.principal, ref, cacheId, actor: d.actor, actorRef: d.actor === requestPrincipal ? requester : principalRef(d.actor) };
}

/** Every ceiling of the resolution (the request principal's and each inherit delegate's), from the validated copies. */
export function ceilingOf(d: Delegation, def: PermissionDef, ref: ResourceRef, ancestors: readonly ResourceRef[] | undefined, instant: Date): CeilingOutcome {
  return mergeCeilings(d.ceilings.map((c) => ceilingOutcome(c, def.name, ref, ancestors, instant)));
}

/** The intersect delegate's full decision: same permission, ref, subject, env and scope, with the hops left. */
export function* delegateCheck(engine: Engine, delegate: Principal, hopsUsed: number, def: PermissionDef, ref: ResourceRef, subject: unknown, env: unknown, run: Run): Pipeline<Checked> {
  const input: { -readonly [K in keyof CheckInput]: CheckInput[K] } = { principal: delegate, permission: def.name };
  if (env !== undefined) input.env = env as Readonly<Record<string, unknown>>;
  return yield* pipeline(engine, input, { ...run, depth: run.depth + 1, delegationBudget: run.delegationBudget - hopsUsed }, { ref, subject });
}
