import type { AuthnContext } from './credentials.js';
import type { PrincipalRef } from './principal.js';

/** The actor of every operator command, so the audit tells it apart from an owner acting on their own credentials. */
export const CLI_ACTOR: PrincipalRef = Object.freeze({ type: 'system', id: 'cli' });

export function cliContext(): AuthnContext {
  return { now: new Date(), purpose: 'request', userAgent: 'spinajs-cli' };
}
