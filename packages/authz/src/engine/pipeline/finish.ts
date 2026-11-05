import type { CombiningAlgorithm, Decision, Trace } from '../../contracts/decision.js';
import { resourceKey } from '../../contracts/resource.js';
import type { DecisionAudit } from '../../contracts/service.js';
import { isThenable } from '../run.js';
import { deepFreeze, thrownError } from '../vote.js';
import { newDecisionId } from '../support/ids.js';
import { audits } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import type { Engine, Finish, Outcome } from '../types.js';

/** Steps 13-15. */
function decisionOf(engine: Engine, f: Finish, o: Outcome): { -readonly [K in keyof Decision]: Decision[K] } {
  const allowed = o.residual.op !== 'false';
  const decision: { -readonly [K in keyof Decision]: Decision[K] } = { allowed, permission: f.def.name, resource: f.ref, principal: o.principal, residual: o.residual, fields: o.fields, roles: o.roles, domain: engine.domain };
  if (o.actor) decision.actor = o.actor;
  if (!allowed) decision.reason = o.reason ?? { code: 'no_access' };
  if (o.validUntil) decision.validUntil = o.validUntil;
  // Only a denial reaches a 403; a decision log names a logged allow itself.
  if (!allowed && f.run.reads !== undefined && f.run.depth === 0) decision.id = newDecisionId();
  return decision;
}

export function finish(engine: Engine, f: Finish, o: Outcome): Decision {
  const decision = decisionOf(engine, f, o);
  const allowed = decision.allowed;

  let trace: Trace | undefined;
  if (f.steps) {
    trace = deepFreeze({ domain: engine.domain, algorithm: f.algorithm as CombiningAlgorithm, models: [...o.models], votes: [...o.votes], steps: [...f.steps], durationMs: performance.now() - f.started });
    if (f.explain) decision.trace = trace;
    if (engine.config.explain) logAt(engine, 'debug', { permission: f.def.name, resource: resourceKey(f.ref), trace }, 'Authz domain ${domain}: trace of ${permission} on ${resource}: ${trace}');
  }
  deepFreeze(decision);

  if (audits(f.run)) {
    const base = { principal: f.requester, permission: f.def.name, resource: f.ref };
    if (f.system) record(engine, { kind: 'system', ...base });
    if (!allowed && engine.config.auditDenials) record(engine, { kind: 'deny', ...base, reason: decision.reason!.code });
    if (f.explain) record(engine, allowed ? { kind: 'explain', ...base, trace } : { kind: 'explain', ...base, reason: decision.reason!.code, trace });
  }
  return decision;
}

export function record(engine: Engine, entry: Parameters<DecisionAudit['record']>[0]): void {
  if (!engine.auditSink) return;
  const failed = (e: unknown) => logAt(engine, 'error', { error: thrownError(e), entryKind: entry.kind }, 'Authz domain ${domain}: audit failed for a ${entryKind} entry');
  try {
    const r = engine.auditSink.record(entry);
    if (isThenable(r)) void r.then(undefined, failed);
  } catch (e) {
    failed(e);
  }
}
