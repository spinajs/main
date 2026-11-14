import type { DenyReason, Vote } from '../../contracts/decision.js';
import { selectDenyReason, staticTruths } from '../reasons.js';
import type { VoteTruths } from '../reasons.js';
import { ENGINE_FAULT } from '../types.js';
import { not } from '../../contracts/filter.js';
import type { ResourceFilter } from '../../contracts/filter.js';
import type { ResourceRef } from '../../contracts/principal.js';
import type { Truth } from '../evaluate.js';
import { evaluateResidual } from '../evaluate.js';
import { settleWithin } from '../run.js';
import type { Pipeline, Settled } from '../run.js';
import type { ModelContext } from '../context.js';
import { describeError, thrownError } from '../vote.js';
import { subjectEnv } from '../context/request.js';
import { logAt } from '../support/plumbing.js';
import type { RefBinder } from '../support/ref-binder.js';
import type { Engine, Parties, Run } from '../types.js';

/** `subjectEvaluated`: the subject itself denied (only then `residual_false`, B36). */
export function denyReason(core: readonly DenyReason[], votes: readonly Vote[], truths: readonly VoteTruths[], deciding: Vote | undefined, algorithm: string, subjectEvaluated: boolean, engineFault: boolean): DenyReason {
  return selectDenyReason({ core: engineFault ? [...core, ENGINE_FAULT] : core, votes, truths, algorithm, deciding, subjectEvaluated });
}

/**
 * Truths of the counted votes against the subject, the loads and the batch
 * under one time limit; static truths for the others and on timeout. Not
 * traced as subject checks: one core 'reason' step holds the result.
 */
export function* subjectTruths(engine: Engine, votes: readonly Vote[], deciding: Vote | undefined, algorithm: string, subject: unknown, binder: RefBinder, parties: Parties, ref: ResourceRef, run: Run, label: string, core: (step: string, note: string, data?: unknown) => void, cores: ModelContext[]): Pipeline<{ readonly truths: readonly VoteTruths[]; readonly uncacheable: boolean }> {
  const started = performance.now();
  const counted: readonly Vote[] = algorithm === 'first-applicable' && deciding !== undefined ? [deciding] : votes;
  const env = subjectEnv(engine, parties, ref, run, undefined, cores);
  let uncacheable: boolean;
  try {
    // Deny entries may read scope nodes the allow did not.
    uncacheable = (yield* binder.cover(counted.filter((v) => v.error === undefined).flatMap((v) => [v.permitWhen, ...(v.denies ?? []).map((d) => d.when)]))).uncacheable;
  } catch (e) {
    // Refs of nodes left unloaded bind as missing.
    logAt(engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: loading the scope attributes of the deny reasons of ${check} failed');
    uncacheable = true;
  }
  // A deny entry sits under `not` in the allow, where the binder reads a missing ref as TRUE: it is bound under `not` here too.
  const truthOf = (f: ResourceFilter, deny: boolean): Promise<Truth> => {
    let bound: ResourceFilter;
    try {
      bound = binder.bind(deny ? not(f) : f);
    } catch {
      uncacheable = true;
      return Promise.resolve(undefined);
    }
    const truth = evaluateResidual(bound, subject, env);
    return deny ? truth.then((t) => (t === undefined ? undefined : !t)) : truth;
  };
  const batch = Promise.all(
    votes.map((v): VoteTruths | Promise<VoteTruths> => {
      if (!counted.includes(v) || v.error !== undefined) return staticTruths(v);
      // Against the subject, a permit that is not TRUE does not permit, whether or not the subject step denied.
      return Promise.all([truthOf(v.permitWhen, false), Promise.all((v.denies ?? []).map((d) => truthOf(d.when, true)))]).then(([permit, denies]) => Object.freeze({ permit: permit === true, denies: Object.freeze(denies) }));
    }),
  );
  const left = Math.max(0, engine.config.modelTimeoutMs - (performance.now() - started));
  const settled = (yield settleWithin(batch, left, describeError, 'deny reason pass')) as Settled;
  if (!settled.ok) {
    logAt(engine, 'error', { check: label, cause: settled.error }, 'Authz domain ${domain}: evaluating the deny reasons of ${check} against the subject failed: ${cause}; using static truths');
    core('reason', 'deny reason against the subject', { fallback: 'static' });
    return { truths: votes.map(staticTruths), uncacheable };
  }
  const truths = settled.value as readonly VoteTruths[];
  const traced = counted.map((v) => {
    const i = votes.indexOf(v);
    return v.error !== undefined || i < 0 ? { model: v.model, indeterminate: true } : { model: v.model, permit: truths[i].permit, denies: truths[i].denies };
  });
  core('reason', 'deny reason against the subject', { truths: traced });
  return { truths, uncacheable };
}
