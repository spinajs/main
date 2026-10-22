import type { AuthnContext, SessionHandle } from '@spinajs/authn/contracts';

import type { AuthnClientContext } from './client.js';

/** ctx.ip is the trusted-proxy chain's ClientIp, never Express's ip (A05, N3). */
export function contextOf(client: AuthnClientContext, purpose: AuthnContext['purpose'], session?: SessionHandle): AuthnContext {
  return clientContext(client.ip, client.userAgent, purpose, session);
}

/** The context of a client at `ip` with `userAgent`, each kept only when it is a string. */
export function clientContext(ip: unknown, userAgent: unknown, purpose: AuthnContext['purpose'], session?: SessionHandle): AuthnContext {
  return { ...(typeof ip === 'string' ? { ip } : {}), ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose, ...(session ? { session } : {}) };
}
