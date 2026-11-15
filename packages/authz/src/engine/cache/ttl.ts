import type { Decision } from '../../contracts/decision.js';
import { validDate } from '../vote.js';
import type { Engine } from '../types.js';

/** min(cacheTtlSeconds, validUntil − now), measured when the decision is stored; undefined when it is not positive. */
export function ttlOf(engine: Engine, decision: Decision): { readonly ms: number; readonly now: number } | undefined {
  let now: number;
  try {
    const date = validDate(engine.clock());
    if (!date) return undefined;
    now = date.getTime();
  } catch {
    return undefined;
  }
  let ms = engine.config.cacheTtlSeconds * 1000;
  if (decision.validUntil !== undefined) ms = Math.min(ms, decision.validUntil.getTime() - now);
  return Number.isFinite(ms) && ms > 0 ? { ms, now } : undefined;
}
