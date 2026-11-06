import { quote } from '@spinajs/util';
import { AuthzConfigError } from '../../contracts/errors.js';
import { FALSE, simplify } from '../../contracts/filter.js';
import type { ResourceFilter } from '../../contracts/filter.js';
import type { DecisionRequest, Vote } from '../../contracts/decision.js';
import type { AuthorizationModel } from '../../contracts/model.js';
import { ModelContext, l1Key } from '../context.js';
import { NEEDS_ASYNC, isThenable, settleWithin, swallow } from '../run.js';
import type { Pipeline } from '../run.js';
import { MAX_DATA_VALUES, MAX_FILTER_NODES, budget, describeError, faultVote, sanitizeFilter, sanitizeVote, thrownError } from '../vote.js';
import { capabilitiesOf, decides, syncMode } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import type { RefBinder } from '../support/ref-binder.js';
import type { Combined, Engine, Run } from '../types.js';

/**
 * Step 8: concurrent under deny-overrides and custom algorithms; in plan
 * order with a stop otherwise. `resolve` (resolveScopeRefs) runs on each vote
 * before the stop rule reads it, so check and explain stop at the same vote.
 */
export function* evaluate(engine: Engine, models: readonly AuthorizationModel[], contexts: readonly ModelContext[], request: () => DecisionRequest, algorithm: string, explain: boolean, run: Run, label: string, resolve: (votes: readonly Vote[]) => Pipeline<Vote[]>, cacheId: string): Pipeline<Vote[]> {
  if (run.sync && models.some((m) => syncMode(m) === 'never')) yield NEEDS_ASYNC;
  // B22: such a model may answer sync from state only its preload loads.
  if (run.sync && models.some((m) => syncMode(m) === 'after-preload') && !wasPreloaded(engine, cacheId, run.scope)) yield NEEDS_ASYNC;

  if (algorithm === 'permit-overrides' || algorithm === 'first-applicable') return yield* inOrder(engine, models, contexts, request, algorithm, explain, run, label, resolve);

  const started: (Vote | PromiseLike<unknown>)[] = [];
  for (let i = 0; i < models.length; i++) {
    const s = start(engine, models[i], contexts[i], request(), run, label);
    if (run.sync && isThenable(s)) yield s;
    started.push(s);
  }
  return yield* resolve(started.some(isThenable) ? ((yield Promise.all(started)) as Vote[]) : (started as Vote[]));
}

/** permit-overrides and first-applicable: in plan order, stopping at the first vote that decides (explain runs every model). */
function* inOrder(engine: Engine, models: readonly AuthorizationModel[], contexts: readonly ModelContext[], request: () => DecisionRequest, algorithm: string, explain: boolean, run: Run, label: string, resolve: (votes: readonly Vote[]) => Pipeline<Vote[]>): Pipeline<Vote[]> {
  const votes: Vote[] = [];
  for (let i = 0; i < models.length; i++) {
    const started = start(engine, models[i], contexts[i], request(), run, label);
    const [vote] = yield* resolve([(isThenable(started) ? yield started : started) as Vote]);
    votes.push(vote);
    if (!explain && decides(algorithm, vote)) break;
  }
  return votes;
}

export function wasPreloaded(engine: Engine, cacheId: string, scope: Map<string, unknown>): boolean {
  if (scope.get(l1Key('preloaded', engine.domain, cacheId)) === engine.generation) return true;
  if (engine.preloaded.get(cacheId) !== engine.generation) return false;
  engine.preloaded.delete(cacheId);
  engine.preloaded.set(cacheId, engine.generation);
  return true;
}

/**
 * B39 (design §5.6): a vote holding a scope.* ref that resolves missing (absent
 * attribute, unknown node, a type-level ref other than $global, a failed or
 * timed-out load) is indeterminate. Loads through the check's binder, so the
 * allow, fields and reasons reuse them; sync mode yields NEEDS_ASYNC before
 * any load.
 */
export function* resolveScopeRefs(engine: Engine, votes: readonly Vote[], binder: RefBinder, label: string, loads: { degraded: boolean }): Pipeline<Vote[]> {
  const filtersOf = (v: Vote): ResourceFilter[] => [v.permitWhen, v.denyWhen, ...(v.denies ?? []).map((d) => d.when)];
  try {
    if ((yield* binder.cover(votes.filter((v) => v.error === undefined).flatMap(filtersOf))).degraded) loads.degraded = true;
  } catch (e) {
    // Nodes left unloaded make their refs missing below.
    loads.degraded = true;
    logAt(engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: loading the scope attributes of the votes of ${check} failed');
  }
  return votes.map((v) => {
    if (v.error !== undefined) return v;
    let fault: string | undefined;
    try {
      const missing = binder.missingScopeRef(filtersOf(v));
      if (missing !== undefined) fault = `scope ref ${quote(missing)} resolves missing`;
    } catch (e) {
      fault = `reading its scope refs failed: ${describeError(e)}`;
    }
    if (fault === undefined) return v;
    logAt(engine, 'error', { model: v.model, check: label, cause: fault }, 'Authz domain ${domain}: model ${model} is indeterminate for ${check}: ${cause}');
    return faultVote(v.model, fault);
  });
}

/** A clean vote, or (async) a promise of one that never rejects, or (sync) the model's thenable. */
export function start(engine: Engine, model: AuthorizationModel, ctx: ModelContext, request: DecisionRequest, run: Run, label: string): Vote | PromiseLike<unknown> {
  let raw: unknown;
  try {
    raw = model.evaluate(request, ctx);
  } catch (e) {
    return accept(engine, model, ctx, { fault: `evaluate threw: ${describeError(e)}` }, label);
  }
  let pending: boolean;
  try {
    pending = isThenable(raw);
  } catch (e) {
    return accept(engine, model, ctx, { fault: `evaluate returned an unreadable value: ${describeError(e)}` }, label);
  }
  if (!pending) return accept(engine, model, ctx, { raw }, label);
  if (run.sync) return raw as PromiseLike<unknown>;
  return settleWithin(raw as PromiseLike<unknown>, engine.config.modelTimeoutMs, describeError, 'evaluate').then((s) => accept(engine, model, ctx, s.ok ? { raw: s.value } : { fault: s.error }, label));
}

/** Step 9: vote hygiene. */
export function accept(engine: Engine, model: AuthorizationModel, ctx: ModelContext, result: { readonly raw: unknown } | { readonly fault: string }, label: string): Vote {
  let vote = 'fault' in result ? faultVote(model.name, result.fault) : sanitizeVote(result.raw, model.name, capabilitiesOf(model));
  if (vote.error === undefined && ctx.fault !== undefined) vote = faultVote(model.name, ctx.fault);
  if (vote.error !== undefined) logAt(engine, 'error', { model: model.name, check: label, cause: vote.error }, 'Authz domain ${domain}: model ${model} is indeterminate for ${check}: ${cause}');
  return vote;
}

/** Step 10. */
export function combine(engine: Engine, algorithm: string, votes: readonly Vote[]): Combined {
  try {
    const combinator = engine.combinators.get(algorithm);
    if (!combinator) throw new AuthzConfigError(`unknown algorithm ${quote(algorithm)}`);
    const result = combinator.combine(votes);
    if (isThenable(result)) {
      swallow(result);
      throw new AuthzConfigError('combine() must be synchronous, it returned a thenable');
    }
    const scale = votes.length * votes.length + 1;
    // first-applicable repeats every earlier vote's not(or(P, D)), so k votes expand to about k * (sum of votes).
    const allow = simplify(sanitizeFilter(result.allow, '*', 'combinator allow', budget(MAX_FILTER_NODES * scale), budget(MAX_DATA_VALUES * scale)));
    return algorithm === 'first-applicable' && result.deciding !== undefined ? { allow, deciding: result.deciding, failed: false } : { allow, failed: false };
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e), algorithm }, 'Authz domain ${domain}: combinator ${algorithm} failed');
    return { allow: FALSE, failed: true };
  }
}
