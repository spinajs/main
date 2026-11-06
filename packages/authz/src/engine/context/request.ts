import { AuthzConfigError } from '../../contracts/errors.js';
import type { DecisionRequest, TraceStep } from '../../contracts/decision.js';
import type { PermissionDef } from '../../contracts/permission.js';
import type { ResourceRef, ResourceType } from '../../contracts/principal.js';
import type { RelationResolver } from '../../contracts/adapter.js';
import { isObject } from '../internal/util.js';
import type { Engine, Parties, Run } from '../types.js';
import { CORE } from '../types.js';
import { ModelContext } from '../context.js';
import { defaultAttribute } from '../evaluate.js';
import type { SubjectEnv } from '../evaluate.js';
import { contextCacheKey, detachingOnThrow } from '../support/misc.js';
import { hostFor } from './host.js';
import { requireRef } from './late-type.js';
import { ancestorsOf } from './scope.js';

export function requestOf(engine: Engine, parties: Parties, def: PermissionDef, ref: ResourceRef, subject: unknown, env: unknown, instant: Date, explain: boolean, fresh: boolean, consistency?: DecisionRequest['consistency']): DecisionRequest {
  const req: { -readonly [K in keyof DecisionRequest]: DecisionRequest[K] } = { principal: parties.principal, permission: def.name, resource: ref, env: envOf(engine, env, instant), explain };
  if (parties.actor) req.actor = parties.actor;
  if (subject !== undefined) req.subject = subject;
  if (fresh) req.fresh = true;
  if (consistency) req.consistency = Object.freeze({ atLeast: consistency.atLeast });
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

/** `cores` gets the env's context. */
export function subjectEnv(engine: Engine, parties: Parties, ref: ResourceRef, run: Run, steps: TraceStep[] | undefined, cores: ModelContext[]): SubjectEnv {
  const adapter = engine.adapterByType.get(ref.type);
  const attribute = adapter && typeof adapter.attribute === 'function' ? (subject: unknown, field: string) => adapter.attribute!(subject, field) : defaultAttribute;
  const ctx = new ModelContext(hostFor(engine, run), CORE, run.scope, run.instant, run.depth, steps, contextCacheKey('\u0000core', parties.cacheId), run.reads);
  cores.push(ctx);
  return {
    principal: parties.principal,
    ref,
    attribute,
    relation: (type, name) => {
      run.reads?.relation(CORE, { type }, name);
      return relation(engine, type, name);
    },
    ancestors: (r) => Promise.resolve(ancestorsOf(engine, requireRef(engine, r), run.scope)),
    native: (op) => {
      const filter = engine.natives.get(op);
      return filter && detachingOnThrow(filter, ctx);
    },
    ctx,
  };
}
