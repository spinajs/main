import type { Credentials } from '../contracts/credentials.js';

/**
 * Optional hook of an AuthenticationStrategy for strategies that share a credential kind (e.g. API tokens and JWTs, both
 * `bearer`). The registry runs the first listed strategy for the kind whose `accepts` returns true; a strategy without it
 * takes every credential of its kinds.
 */
export interface CredentialSelector {
  accepts(c: Credentials): boolean;
}

export function isCredentialSelector(value: unknown): value is CredentialSelector {
  return value !== null && typeof value === 'object' && typeof (value as { accepts?: unknown }).accepts === 'function';
}
