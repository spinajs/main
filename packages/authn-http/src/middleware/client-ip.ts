import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ServerMiddleware, parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import type * as express from 'express';

/** authn.http.trustProxy, else http.trustProxy (only when the former is null or absent); a bad value throws. */
export function authnProxyTrust(config: Configuration): ProxyTrust {
  const own = config.get<unknown>('authn.http.trustProxy');
  return own === null || own === undefined ? parseTrustProxy(config.get<unknown>('http.trustProxy'), 'http.trustProxy') : parseTrustProxy(own, 'authn.http.trustProxy');
}

/**
 * Order 1. Writes req.storage.ClientIp: the socket address, or the client address behind trusted proxy hops only
 * (authn.http.trustProxy, else http.trustProxy; none ⇒ the socket address) (A05).
 */
@Injectable(ServerMiddleware)
export class ClientIp extends ServerMiddleware {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  constructor() {
    super();
    this.Order = 1;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    const trust = authnProxyTrust(this.Configuration);
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      req.storage.ClientIp = trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trust);
      next();
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
