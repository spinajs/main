import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { RealIp, ServerMiddleware, parseTrustProxyOverride, trustedClientAddress } from '@spinajs/http';
import type { IMiddlewareContext, ProxyTrust } from '@spinajs/http';
// Declares req.storage.ClientIp.
import type {} from '../api.js';

/**
 * authn.http.trustProxy, else http.trustProxy (only when the former is null or absent). The schemas judge the types;
 * `parseTrustProxy` compiles the setting and throws, naming the key, for an entry that is no address or CIDR.
 */
export function proxyTrustOf(own: unknown, shared: unknown): ProxyTrust {
  return parseTrustProxyOverride(own, 'authn.http.trustProxy', shared);
}

/**
 * http's RealIp with the trust of {@link proxyTrustOf}: registered over RealIp, so `req.storage.realIp` and
 * `proxyTrust` follow authn.http.trustProxy, and @RateLimit, http.throttle and authn count one client address (A05).
 */
export class AuthnRealIp extends RealIp {
  @Config('authn.http.trustProxy')
  protected AuthnTrustProxy: unknown;

  constructor() {
    super();
    // Ahead of ClientIp (1): the server does not keep equal Orders in registration order.
    this.Order = 0;
  }

  protected override proxyTrust(): ProxyTrust {
    return proxyTrustOf(this.AuthnTrustProxy, this.TrustProxy);
  }
}

const NO_PROXY: ProxyTrust = Object.freeze({ hops: 0 });

/**
 * Order 1, after {@link AuthnRealIp} (0). Writes req.storage.ClientIp: `req.storage.realIp`, the one client address of
 * the app, kept under this name for authn's readers.
 */
@Injectable(ServerMiddleware)
export class ClientIp extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    // Without RealIp no proxy is trusted, as requestProxyTrust has it: the socket address, never X-Forwarded-For.
    storage.ClientIp = storage.proxyTrust === undefined ? trustedClientAddress(req.socket?.remoteAddress, undefined, NO_PROXY) : storage.realIp;
  }
}
