import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { RealIp, parseTrustProxyOverride } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import type * as express from 'express';

/**
 * Replaces http's RealIp (Order 1): `req.storage.realIp`, `req.storage.proxyTrust` and `req.storage.ClientIp` all follow
 * the deprecated `authn.http.trustProxy` when it is set, else `http.trustProxy` (A05).
 */
@Injectable(RealIp)
export class ClientIp extends RealIp {
  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Logger('authn-http')
  protected Log!: Log;

  protected proxyTrust(): ProxyTrust {
    const trust = parseTrustProxyOverride(this.OwnTrust, 'authn.http.trustProxy', this.TrustProxy);
    if (this.OwnTrust !== null && this.OwnTrust !== undefined) {
      this.Log?.warn('authn.http.trustProxy is deprecated and will be removed: move its value to http.trustProxy');
    }
    return trust;
  }

  public before(): (req: Request, res: express.Response, next: express.NextFunction) => void {
    const resolve = super.before();
    return (req: Request, res: express.Response, next: express.NextFunction) =>
      resolve(req, res, (err?: unknown) => {
        req.storage.ClientIp = req.storage.realIp;
        next(err);
      });
  }
}
