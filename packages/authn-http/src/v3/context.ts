import type { Request } from '@spinajs/http';
import type { AuthnContext, SessionHandle } from '@spinajs/authn/contracts';

/** ctx.ip is the trusted-proxy chain's ClientIp, never Express's ip (A05, N3). */
export function contextOf(req: Request, purpose: AuthnContext['purpose'], session?: SessionHandle): AuthnContext {
  return clientContext(req.storage.ClientIp, req.headers['user-agent'], purpose, session);
}

/** The context of a client at `ip` with `userAgent`, each kept only when it is a string. */
export function clientContext(ip: unknown, userAgent: unknown, purpose: AuthnContext['purpose'], session?: SessionHandle): AuthnContext {
  return { ...(typeof ip === 'string' ? { ip } : {}), ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose, ...(session ? { session } : {}) };
}
