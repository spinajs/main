import type { Decision, DecisionRequest } from '../../contracts/decision.js';
import type { CheckInput } from '../../contracts/service.js';
import type { DecisionReadSet } from '../../contracts/tap.js';
import { isObject } from '../internal/util.js';
import { isThenable } from '../run.js';
import { thrownError } from '../vote.js';
import { logAt } from '../support/plumbing.js';
import type { ReadRecorder } from '../support/reads.js';
import type { Checked, Engine, Run } from '../types.js';

/** A decision from the L1 or the L2: the top-level one is marked cached, so its taps know nothing was read now. */
export function cacheHit(run: Run, hit: Checked): Checked {
  if (run.depth === 0 && run.reads) run.reads.cached = true;
  return hit;
}

/** Runs after finish, so the taps see the decision as it was audited and cached. */
export function tap(engine: Engine, input: CheckInput, instant: Date, checked: Checked, reads: ReadRecorder, durationMs: number): void {
  let req: DecisionRequest;
  let set: DecisionReadSet;
  try {
    req = tapRequest(input, checked.decision, instant);
    set = reads.readSet(engine.modelList);
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e), permission: checked.decision.permission }, 'Authz domain ${domain}: the decision taps of ${permission} were skipped: their input could not be built');
    return;
  }
  const meta = { cached: reads.cached, durationMs };
  const failed = (e: unknown) => logAt(engine, 'error', { error: thrownError(e), permission: checked.decision.permission }, 'Authz domain ${domain}: a decision tap failed on ${permission}; the decision stands');
  for (const t of engine.taps) {
    try {
      const r: unknown = t.onDecision(req, checked.decision, set, meta);
      if (isThenable(r)) void r.then(undefined, failed);
    } catch (e) {
      failed(e);
    }
  }
}

/** The request as the caller made it, with the decision's resolved permission and resource. */
function tapRequest(input: CheckInput, decision: Decision, instant: Date): DecisionRequest {
  const env = isObject(input.env) && !Array.isArray(input.env) ? input.env : {};
  const req: { -readonly [K in keyof DecisionRequest]: DecisionRequest[K] } = { principal: input.principal, permission: decision.permission, resource: decision.resource, env: Object.freeze({ ...env, now: new Date(instant.getTime()) }), explain: input.explain === true };
  if (input.actor !== undefined) req.actor = input.actor;
  if (input.subject !== undefined) req.subject = input.subject;
  if (input.fresh === true) req.fresh = true;
  return Object.freeze(req);
}
