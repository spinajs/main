import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';

// Copies of authn-keys' CLI actor and context; authn-totp does not depend on authn-keys.

export const CLI_ACTOR: PrincipalRef = Object.freeze({ type: 'system', id: 'cli' });

export function cliContext(): AuthnContext {
  return { now: new Date(), purpose: 'request', userAgent: 'spinajs-cli' };
}
