import type { Decision, DecisionRequest } from '../../contracts/decision.js';
import type { CheckInput } from '../../contracts/service.js';
import type { DecisionReadSet } from '../../contracts/tap.js';
import { isObject } from '../internal/util.js';
import { isThenable } from '../run.js';
import { thrownError } from '../vote.js';
import { newDecisionId } from '../support/ids.js';
import { logAt } from '../support/plumbing.js';
import type { ReadRecorder } from '../support/reads.js';
import type { Checked, Engine, Run } from '../types.js';

/** A decision from the L1 or the L2: the top-level one is marked cached, so its taps know nothing was read now; a denial gets an id of its own. */
export function cacheHit(run: Run, hit: Checked): Checked {
  if (run.depth > 0 || run.reads === undefined) return hit;
  run.reads.cached = true;
  return hit.decision.allowed ? hit : { ...hit, decision: Object.freeze({ ...hit.decision, id: newDecisionId() }) };
}

/** Runs after finish, so the taps see the decision as it was audited and cached. */
export function tap(engine: Engine, input: CheckInput, instant: Date, checked: Checked, reads: ReadRecorder, durationMs: number): void {
  if (!wanted(engine, checked.decision)) return;
  let req: DecisionRequest;
  let set: DecisionReadSet;
  try {
    req = tapRequest(input, checked.decision, instant, reads.env);
    set = reads.readSet(engine.modelList);
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e), permission: checked.decision.permission }, 'Authz domain ${domain}: the decision taps of ${permission} were skipped: their input could not be built');
    return;
  }
  const meta = { cached: reads.cached, durationMs };
  for (const t of engine.taps) {
    try {
      const r: unknown = t.onDecision(req, checked.decision, set, meta);
      if (isThenable(r)) void r.then(undefined, (e: unknown) => tapFailed(engine, checked.decision, e));
    } catch (e) {
      tapFailed(engine, checked.decision, e);
    }
  }
}

function wanted(engine: Engine, decision: Decision): boolean {
  for (const t of engine.taps) {
    try {
      if (typeof t.wants !== 'function' || t.wants(decision)) return true;
    } catch (e) {
      tapFailed(engine, decision, e);
    }
  }
  return false;
}

function tapFailed(engine: Engine, decision: Decision, e: unknown): void {
  logAt(engine, 'error', { error: thrownError(e), permission: decision.permission }, 'Authz domain ${domain}: a decision tap failed on ${permission}; the decision stands');
}

/** The request as the caller made it, with the decision's resolved permission and resource. */
function tapRequest(input: CheckInput, decision: Decision, instant: Date, given: Readonly<Record<string, unknown>> | undefined): DecisionRequest {
  const req: { -readonly [K in keyof DecisionRequest]: DecisionRequest[K] } = { principal: input.principal, permission: decision.permission, resource: decision.resource, env: given ?? envAt(input.env, instant), explain: input.explain === true };
  if (input.actor !== undefined) req.actor = input.actor;
  if (input.subject !== undefined) req.subject = input.subject;
  if (input.fresh === true) req.fresh = true;
  return Object.freeze(req);
}

/** The env of a check that ended before the models: the caller's keys and `now`. */
function envAt(env: unknown, instant: Date): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...(isObject(env) && !Array.isArray(env) ? env : {}), now: new Date(instant.getTime()) });
}
