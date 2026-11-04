import { AuthzConfigError } from '../../contracts/errors.js';
import { FALSE } from '../../contracts/filter.js';
import type { ResourceFilter } from '../../contracts/filter.js';
import type { Vote } from '../../contracts/decision.js';
import type { ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import type { Pipeline } from '../run.js';
import { thrownError } from '../vote.js';
import { nodeLoad, logTimeout } from '../context/scope.js';
import { logAt } from '../support/plumbing.js';
import { RefBinder, bounded } from '../support/ref-binder.js';
import { NO_FIELDS } from '../types.js';
import type { BoundAttributes, Engine, Fields, LoadedAttributes, Parties, Run } from '../types.js';

/** Step 11's binder for one check, shared with the reason pass so both read the same refs and attributes. */
export function refBinder(engine: Engine, parties: Parties, env: Readonly<Record<string, unknown>>, ancestors: readonly ResourceRef[] | undefined, run: Run): RefBinder {
  return new RefBinder({ principal: parties.principal, env }, parties.actor ?? parties.principal, ancestors, run.sync, (node) => boundAttributes(engine, node, run.scope), run.reads);
}

/** Step 11. A malformed node or a binder error gives FALSE (fail closed). */
export function* bind(engine: Engine, allow: ResourceFilter, binder: RefBinder): Pipeline<{ readonly residual: ResourceFilter; readonly failed: boolean; readonly degraded: boolean; readonly uncacheable: boolean }> {
  try {
    const covered = yield* binder.cover([allow]);
    return { residual: binder.bind(allow), failed: covered.failed, degraded: covered.degraded, uncacheable: covered.uncacheable };
  } catch (e) {
    logAt(engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: binding refs failed');
    return { residual: FALSE, failed: true, degraded: true, uncacheable: true };
  }
}

/**
 * A scope node's attributes for the binder, never waiting past modelTimeoutMs
 * (a model may already have given up on the memoised load). Either failure
 * leaves the node unknown; only a rejection is an engine fault.
 */
export function boundAttributes(engine: Engine, node: ResourceRef, scope: Map<string, unknown>): Promise<BoundAttributes> {
  const load = nodeLoad(engine, node, scope);
  return bounded(() => load.result, engine.config.modelTimeoutMs).then((r): BoundAttributes => {
    if (r.kind === 'value') return { ...(r.value as LoadedAttributes), failed: false };
    if (r.kind === 'error') logAt(engine, 'error', { error: thrownError(r.error), resource: resourceKey(node) }, 'Authz domain ${domain}: scope attributes of ${resource} failed; its refs bind as missing');
    else logTimeout(engine, load, { resource: resourceKey(node), timeoutMs: engine.config.modelTimeoutMs }, 'Authz domain ${domain}: scope attributes of ${resource} timed out after ${timeoutMs} ms; its refs bind as missing');
    return { attributes: null, failed: r.kind === 'error', degraded: true };
  });
}

/**
 * Fields of an allowed decision, intersected with an intersect delegate's.
 * The votes' terms are bound like the allow; their refs may be gone from the
 * simplified allow, so their scope nodes are loaded first. `failed`: an
 * AuthzConfigError (glob budget, binder), which denies with model_error.
 * A degraded or failed load leaves its refs missing: the decision stands
 * but is faulted and not cached. `firm` (firm runs) also gives `firm`,
 * intersected with the delegate's firm fields.
 */
export function* fieldsOf(engine: Engine, algorithm: string, votes: readonly Vote[], binder: RefBinder, delegate: Fields | undefined, label: string, firm?: { readonly delegate?: Fields }): Pipeline<{ readonly fields: Fields; readonly firm?: Fields; readonly failed: boolean; readonly faulted: boolean; readonly uncacheable: boolean }> {
  let uncacheable: boolean;
  let faulted: boolean;
  try {
    const covered = yield* binder.cover(votes.filter((v) => v.error === undefined).flatMap((v) => [v.permitWhen, v.denyWhen]));
    uncacheable = covered.uncacheable;
    faulted = covered.degraded;
  } catch (e) {
    // Refs of nodes left unloaded bind as missing: fewer fields, more hidden.
    logAt(engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: loading the scope attributes of the field sets of ${check} failed');
    uncacheable = true;
    faulted = true;
  }
  try {
    const own = engine.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f));
    const fields = delegate ? engine.fieldCombiner.intersect(own, delegate) : own;
    if (!firm) return { fields, failed: false, faulted, uncacheable };
    const firmOwn = engine.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f), true);
    return { fields, firm: firm.delegate ? engine.fieldCombiner.intersect(firmOwn, firm.delegate) : firmOwn, failed: false, faulted, uncacheable };
  } catch (e) {
    if (!(e instanceof AuthzConfigError)) throw e;
    logAt(engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: combining the field sets of ${check} failed');
    return { fields: NO_FIELDS, failed: true, faulted: true, uncacheable: true };
  }
}
