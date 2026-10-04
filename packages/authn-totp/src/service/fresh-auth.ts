import { InvalidOption } from '@spinajs/exceptions';
import type { AuthnFacts } from '@spinajs/authn/contracts';

// A copy of authn's isFresh: FreshAuthCheck refuses pending sessions, which the forced first enrolment needs, and
// authn's root entry registers DefaultAuthnService as a side effect.

export const DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS = 300;

/** `authenticatedAt` within `maxAgeSeconds` before `now`, boundary included; never for a future or invalid time or an impersonation. */
export function isFresh(facts: Pick<AuthnFacts, 'authenticatedAt' | 'impersonator'>, now: Date, maxAgeSeconds: number): boolean {
  if (facts?.impersonator !== undefined) {
    return false;
  }
  const at = facts?.authenticatedAt;
  if (!(at instanceof Date) || !(now instanceof Date)) {
    return false;
  }
  const age = now.getTime() - at.getTime();
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

/** `authn.freshAuth.maxAgeSeconds`: a positive integer, default 300. */
export function freshAuthMaxAge(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new InvalidOption('authn.freshAuth.maxAgeSeconds must be a positive integer');
  }
  return raw;
}
