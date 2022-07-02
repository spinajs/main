import { SessionProvider, User, UserSession } from '@spinajs/rbac';
import { Autoinject, Injectable } from '@spinajs/di';
import 'reflect-metadata';
import * as express from 'express';
import { Config } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import { DateTime } from 'luxon';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';

@Injectable(ServerMiddleware)
export class UserFromSessionMiddleware extends ServerMiddleware {
  @Config('http.cookie.secret')
  protected CoockieSecret: string;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  public async resolveAsync() {
    if (!this.CoockieSecret) {
      throw new Error('http.cookie.secres is not set, cannot start UserFromSessionMiddleware. Set this value in configuration file !');
    }
  }

  public before(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return async (req: sRequest, _res: express.Response, _next: express.NextFunction) => {
      if (req.cookies.ssid) {
        const ssid: string | false = cs.unsign(req.cookies.ssid, this.CoockieSecret);
        if (ssid) {
          const session = (await this.SessionProvider.restoreSession(ssid)) as UserSession;
          if (session) {
            req.storage.user = new User(session.Data);
            const liveTimeDiff = session.Expiration.diff(DateTime.now());
            if (liveTimeDiff.minutes < 30) {
              await this.SessionProvider.refreshSession(session);
            }
          }
        } else {
          req.storage.user = null;
        }
      }
    };
  }
  public after(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return null;
  }
}
