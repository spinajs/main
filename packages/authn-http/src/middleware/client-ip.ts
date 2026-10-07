import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { ServerMiddleware, parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import type * as express from 'express';

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

  constructor() {
    super();
    this.Order = 1;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      req.storage.ClientIp = trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trust);
      next();
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
