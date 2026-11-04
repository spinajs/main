import { AuthzConfigError } from '../../contracts/errors.js';
import type { DecisionRequest } from '../../contracts/decision.js';
import type { PermissionDef } from '../../contracts/permission.js';
import type { ResourceRef, ResourceType } from '../../contracts/principal.js';
import type { RelationResolver } from '../../contracts/adapter.js';
import { isObject } from '../internal/util.js';
import type { Engine, Parties } from '../types.js';

export function requestOf(engine: Engine, parties: Parties, def: PermissionDef, ref: ResourceRef, subject: unknown, env: unknown, instant: Date, explain: boolean, fresh: boolean): DecisionRequest {
  const req: { -readonly [K in keyof DecisionRequest]: DecisionRequest[K] } = { principal: parties.principal, permission: def.name, resource: ref, env: envOf(engine, env, instant), explain };
  if (parties.actor) req.actor = parties.actor;
  if (subject !== undefined) req.subject = subject;
  if (fresh) req.fresh = true;
  return Object.freeze(req);
}

/** A fresh frozen env per use; `now` from the clock always wins. */
export function envOf(engine: Engine, env: unknown, instant: Date): Readonly<Record<string, unknown>> {
  if (env !== undefined && (!isObject(env) || Array.isArray(env))) throw new AuthzConfigError(`${engine.where}: env must be an object`);
  return Object.freeze({ ...env, now: new Date(instant.getTime()) });
}

export function relation(engine: Engine, type: ResourceType, name: string): RelationResolver | undefined {
  return engine.relationIndex.get(`${type}\u0000${name}`);
}
