import { l1Key, memo } from '../context.js';
import { versionVector } from '../cache-key.js';
import { thrownError } from '../vote.js';
import { compileTable } from '../support/setup.js';
import { logAt } from '../support/plumbing.js';
import { nextGeneration } from '../types.js';
import type { Engine } from '../types.js';

/** The version vector of a top-level call. A change recompiles the routes and drops the L2; undefined turns caching off for the call. */
export function epoch(engine: Engine): string | undefined {
  // The first failure was logged at error; a cache that stays down would log every call.
  if (engine.l2Stale) invalidateL2(engine, ['*'], 'debug');
  const versions = versionVector(engine.modelList);
  if (versions === undefined) {
    if (!engine.versionsWarned) {
      engine.versionsWarned = true;
      logAt(engine, 'warn', {}, "Authz domain ${domain}: a model's version() threw or returned a non-string; decisions are not cached while it does");
    }
    return undefined;
  }
  if (versions !== engine.versions) {
    engine.generation = nextGeneration();
    invalidateL2(engine, ['*']);
    try {
      engine.table = compileTable(engine);
    } catch (e) {
      // The old routes stay; the next call tries again.
      logAt(engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: recompiling the routes after a model version change failed; decisions are not cached');
      return undefined;
    }
    engine.versions = versions;
  }
  return versions;
}

/** The generation when this Authorizer first touched the request scope (its first run or preload). */
export function bornOf(engine: Engine, scope: Map<string, unknown>): number {
  return memo(scope, l1Key('generation', engine.domain, ''), () => engine.generation);
}

export function invalidateL2(engine: Engine, tags: readonly string[], level: 'error' | 'debug' = 'error'): void {
  if (!engine.cache) return;
  try {
    engine.cache.invalidate(tags);
    if (tags.includes('*')) engine.l2Stale = false;
  } catch (e) {
    engine.l2Stale = true;
    logAt(engine, level, { error: thrownError(e), tags }, 'Authz domain ${domain}: the decision cache failed to invalidate ${tags}; it is not used until a full invalidation succeeds');
  }
}
