import { Perf } from '@spinajs/log-common';
import type { Decision } from '../../contracts/decision.js';
import type { PermissionDef } from '../../contracts/permission.js';
import type { PrincipalRef, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import { l1Key } from '../context.js';
import { isObject } from '../internal/util.js';
import { swallow } from '../run.js';
import { deepFreeze, thrownError, validDate } from '../vote.js';
import { audits, nest, withOwnDate } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import { record } from '../pipeline/finish.js';
import { CachedDecision } from '../types.js';
import type { Checked, Engine, Run } from '../types.js';
import { ttlOf } from './ttl.js';

/** L1, then L2. An L1 hit is not audited again, unless no audit recorded its denial yet; an L2 hit is audited like a fresh decision. */
export function cached(engine: Engine, key: string, run: Run, def: PermissionDef, ref: ResourceRef, requester: PrincipalRef, runAs: PrincipalRef): Checked | undefined {
  const now = run.instant.getTime();
  const l1 = l1Key('decision', engine.domain, key);
  const entry = run.scope.get(l1);
  if (entry instanceof CachedDecision && entry.generation === engine.generation && now < entry.expiresAt) {
    Perf.count('authz.cache.l1.hit');
    if (run.depth > 0) nest(run, entry.tags);
    if (entry.unaudited && audits(run)) {
      entry.unaudited = false;
      auditDenial(engine, requester, def, ref, entry.decision);
    }
    return { decision: withOwnDate(entry.decision), uncacheable: false, faulted: false };
  }
  const decision = fromL2(engine, key, def, ref, runAs, now);
  if (!decision) return undefined;
  Perf.count('authz.cache.l2.hit');
  // The L2 returns no tags, so what the stored decision rested on (nested checks, scope nodes) is unknown here.
  if (run.depth > 0) nest(run, undefined);
  const ttl = ttlOf(engine, decision);
  if (ttl) run.scope.set(l1, new CachedDecision(decision, undefined, ttl.now + ttl.ms, run.generation, !decision.allowed && !audits(run)));
  if (audits(run) && !decision.allowed) auditDenial(engine, requester, def, ref, decision);
  return { decision: withOwnDate(decision), uncacheable: false, faulted: false };
}

/** The L2 entry for `key` when it is usable; a failed get and an unusable entry are logged. */
function fromL2(engine: Engine, key: string, def: PermissionDef, ref: ResourceRef, runAs: PrincipalRef, now: number): Decision | undefined {
  if (!engine.cache || engine.l2Stale) return undefined;
  let found: unknown;
  try {
    found = engine.cache.get(key);
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: the decision cache failed on get');
    return undefined;
  }
  swallow(found);
  const decision = usable(engine, found, def, ref, runAs, now);
  if (!decision && found !== undefined) logAt(engine, 'warn', { permission: def.name, resource: resourceKey(ref) }, 'Authz domain ${domain}: ignored a cached decision that does not match ${permission} on ${resource} or has expired');
  return decision;
}

export function auditDenial(engine: Engine, requester: PrincipalRef, def: PermissionDef, ref: ResourceRef, decision: Decision): void {
  if (engine.config.auditDenials) record(engine, { kind: 'deny', principal: requester, permission: def.name, resource: ref, reason: decision.reason?.code ?? 'no_access' });
}

/** A decision from the L2 is used only when it is what this check asks for and still valid. */
export function usable(engine: Engine, v: unknown, def: PermissionDef, ref: ResourceRef, runAs: PrincipalRef, now: number): Decision | undefined {
  if (!isObject(v) || !answers(engine, v, def, ref, runAs)) return undefined;
  if (v.validUntil !== undefined) {
    const until = validDate(v.validUntil);
    if (!until || until.getTime() <= now) return undefined;
  }
  return Object.isFrozen(v) ? (v as unknown as Decision) : deepFreeze(v as unknown as Decision);
}

/** `v` is a decision of this domain on `def`, `ref` and `runAs` whose `allowed` agrees with its residual. */
function answers(engine: Engine, v: Record<string, unknown>, def: PermissionDef, ref: ResourceRef, runAs: PrincipalRef): boolean {
  if (typeof v.allowed !== 'boolean' || v.domain !== engine.domain || v.permission !== def.name || !isObject(v.residual) || !isObject(v.resource)) return false;
  return v.allowed === (v.residual.op !== 'false') && isObject(v.principal) && v.principal.type === runAs.type && v.principal.id === runAs.id && v.resource.type === ref.type && (v.resource.id ?? undefined) === ref.id;
}
