import type { AuthorizationModel } from '../../contracts/model.js';
import type { Principal, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import { entryTags } from '../cache-key.js';
import { l1Key, memo } from '../context.js';
import type { MaybePromise } from '../context.js';
import { isThenable } from '../run.js';
import { thrownError } from '../vote.js';
import { audits, nest, withOwnDate } from '../support/misc.js';
import { logAt } from '../support/plumbing.js';
import { CachedDecision } from '../types.js';
import type { Checked, Engine, NodeLoad, Run } from '../types.js';
import { ttlOf } from './ttl.js';

/** Stores a cacheable decision (L1 always, L2 when its tags are known and no invalidate came since the scope was born) and hands its tags to the decisions above. */
export function remember(engine: Engine, checked: Checked, key: string | undefined, run: Run, tags: () => readonly string[] | undefined): Checked {
  if (run.depth > 0) {
    if (checked.uncacheable) run.nested.uncacheable = true;
    else nest(run, tags());
  }
  if (key === undefined || checked.uncacheable) return checked;
  const ttl = ttlOf(engine, checked.decision);
  if (!ttl) return checked;
  const t = tags();
  const stored = withOwnDate(checked.decision);
  run.scope.set(l1Key('decision', engine.domain, key), new CachedDecision(stored, t, ttl.now + ttl.ms, run.generation, !stored.allowed && !audits(run)));
  if (engine.cache && !engine.l2Stale && t !== undefined && engine.generation === run.generation) {
    try {
      engine.cache.set(key, stored, t, ttl.ms);
    } catch (e) {
      logAt(engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: the decision cache failed on set');
    }
  }
  return checked;
}

/** entryTags plus every scope node the request loaded (binder or ctx.attributes) and the nested decisions' tags; undefined when some nested tags are unknown. */
export function tagsOf(engine: Engine, models: readonly AuthorizationModel[], principals: readonly Principal[], ref: ResourceRef, ancestors: readonly ResourceRef[] | undefined, run: Run): readonly string[] | undefined {
  let base: readonly string[] | undefined;
  try {
    base = entryTags({ models: models.map((m) => m.name), principals, ref, ancestors: ref.id === undefined ? undefined : ancestors });
  } catch {
    return undefined;
  }
  if (base === undefined || run.nested.untagged) return undefined;
  const out = new Set(base);
  for (const load of loads(engine, run.scope)) out.add(`scope:${resourceKey(load.ref)}`);
  for (const t of run.nested.tags) out.add(t);
  return Object.freeze([...out].sort());
}

/** Every scope node load of this request, in this domain. */
export function loads(engine: Engine, scope: Map<string, unknown>): NodeLoad[] {
  return memo(scope, l1Key('nodes', engine.domain, ''), () => [] as NodeLoad[]);
}

/** A model may memoise in ctx.cache what a degraded load or a rejected host call gave it, so every later decision of the request may rest on it. */
export function scopeFaulted(engine: Engine, scope: Map<string, unknown>): boolean {
  return scope.get(l1Key('fault', engine.domain, '')) === true || loads(engine, scope).some((l) => l.degraded);
}

export function markFault(engine: Engine, scope: Map<string, unknown>): void {
  scope.set(l1Key('fault', engine.domain, ''), true);
}

/** Marks the request scope when the call throws or rejects, then lets the failure through. */
export function marking<T>(engine: Engine, scope: Map<string, unknown>, call: () => MaybePromise<T>): MaybePromise<T> {
  let r: MaybePromise<T>;
  try {
    r = call();
  } catch (e) {
    markFault(engine, scope);
    throw e;
  }
  if (!isThenable(r)) return r;
  return Promise.resolve(r).catch((e: unknown) => {
    markFault(engine, scope);
    throw e;
  });
}
