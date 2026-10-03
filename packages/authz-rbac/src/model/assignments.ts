import { principalKey, resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject } from '@spinajs/authz';

// '%' never starts a principalKey unescaped, so a set key cannot equal a principal's.
export const subjectKey = (s: AssignmentSubject): string => ('set' in s ? `%set:${JSON.stringify([s.set.role, resourceKey(s.set.scope)])}` : principalKey(s));

/** `expiresAt` in ms: undefined for no expiry, NaN when it is not a valid Date (a string from a store, an invalid Date). */
export function expiryTime(a: Assignment): number | undefined {
  const at: unknown = a.expiresAt;
  if (at == null) return undefined;
  try {
    // Reads a Date from another realm too, and throws for anything that is not a Date.
    return Date.prototype.getTime.call(at);
  } catch {
    return NaN;
  }
}

/** Live strictly before `expiresAt`, as the engine's ceiling and cache treat expiry; an unreadable expiry is expired. */
export const isLive = (a: Assignment, at: Date): boolean => {
  const expires = expiryTime(a);
  return expires === undefined || expires > at.getTime();
};
