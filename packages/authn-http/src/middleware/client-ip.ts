import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { ServerMiddleware, parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { IMiddlewareContext, ProxyTrust } from '@spinajs/http';
// Declares req.storage.ClientIp.
import type {} from '../api.js';

/**
 * authn.http.trustProxy, else http.trustProxy (only when the former is null or absent). The schemas judge the types;
 * `parseTrustProxy` compiles the setting and throws, naming the key, for an entry that is no address or CIDR.
 */
export function proxyTrustOf(own: unknown, shared: unknown): ProxyTrust {
  return own === null || own === undefined ? parseTrustProxy(shared, 'http.trustProxy') : parseTrustProxy(own, 'authn.http.trustProxy');
}

/**
 * Order 1. Writes req.storage.ClientIp: the socket address, or the client address behind trusted proxy hops only
 * (authn.http.trustProxy, else http.trustProxy; none ⇒ the socket address) (A05).
 */
@Injectable(ServerMiddleware)
export class ClientIp extends ServerMiddleware {
  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  private trust?: ProxyTrust;

  constructor() {
    super();
    this.Order = 1;
  }

  /** Parses the trust, so a bad setting fails the boot. */
  public async resolve(): Promise<void> {
    this.proxyTrust();
    await super.resolve();
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    storage.ClientIp = trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], this.proxyTrust());
  }

  private proxyTrust(): ProxyTrust {
    return (this.trust ??= proxyTrustOf(this.OwnTrust, this.SharedTrust));
  }
}
