import type { AuthnFacts } from './principal.js';

// RangeError, not InvalidArgument: contracts import nothing but @spinajs/di (boundary test).
/**
 * True when `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary included. A time after `now` or
 * an invalid one is not fresh, nor is an impersonation: the impersonator must not act on the target's credentials (M6).
 */
export function isFresh(facts: Pick<AuthnFacts, 'authenticatedAt' | 'impersonator'>, now: Date, maxAgeSeconds: number): boolean {
  if (typeof maxAgeSeconds !== 'number' || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError('isFresh: maxAgeSeconds must be a positive number');
  }
  if (facts?.impersonator !== undefined) return false;
  const at = facts?.authenticatedAt;
  if (!(at instanceof Date) || !(now instanceof Date)) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age <= maxAgeSeconds * 1000;
}
