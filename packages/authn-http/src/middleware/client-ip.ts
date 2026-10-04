import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ServerMiddleware, parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type * as express from 'express';

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
    const own = this.Configuration.get<unknown>('authn.http.trustProxy');
    const trust = own === null || own === undefined ? parseTrustProxy(this.Configuration.get<unknown>('http.trustProxy'), 'http.trustProxy') : parseTrustProxy(own, 'authn.http.trustProxy');
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      req.storage.ClientIp = trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trust);
      next();
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
