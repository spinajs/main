import type { Request } from '@spinajs/http';
import type { Principal, Session } from '@spinajs/authn/contracts';

/**
 * What `@ClientContext()` resolves to: the caller as the global middlewares left it. `ip` is ClientIp (the
 * trusted-proxy chain, A05), never Express's ip; `session` includes a pending one, so it is not authentication: only
 * `principal.authenticated` is.
 */
export interface AuthnClientContext {
  readonly ip?: string;
  readonly userAgent?: string;
  readonly session?: Session;
  readonly principal?: Principal;
}

export function clientOf(req: Request): AuthnClientContext {
  const ip: unknown = req.storage?.ClientIp;
  const userAgent: unknown = req.headers?.['user-agent'];
  const session = req.storage?.AuthnSession ?? undefined;
  const principal = req.storage?.AuthnPrincipal ?? undefined;
  return {
    ...(typeof ip === 'string' ? { ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(session ? { session } : {}),
    ...(principal ? { principal } : {}),
  };
}
