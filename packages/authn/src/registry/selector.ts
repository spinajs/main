import type { Credentials } from '../contracts/credentials.js';

/**
 * Optional hook of an AuthenticationStrategy for strategies that share a credential kind (e.g. API tokens and JWTs, both
 * `bearer`). A strategy whose `accepts` returns anything but true is left out of the candidates for that credential; one
 * without it is a candidate for every credential of its kinds and answers `unsupported_credentials` to pass it on.
 */
export interface CredentialSelector {
  accepts(c: Credentials): boolean;
}

export function isCredentialSelector(value: unknown): value is CredentialSelector {
  return value !== null && typeof value === 'object' && typeof (value as { accepts?: unknown }).accepts === 'function';
}
