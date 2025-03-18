import { ISession, SessionProvider, User } from '@spinajs/rbac';
import { Autoinject, DI, Injectable } from '@spinajs/di';
import 'reflect-metadata';
import * as express from 'express';
import { Config } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';

@Injectable(ServerMiddleware)
export class RbacMiddleware extends ServerMiddleware {
  @Config('http.cookie.secret')
  protected CoockieSecret: string;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  public async resolve() {
    if (!this.CoockieSecret) {
      throw new Error('http.cookie.secrets is not set, cannot start UserFromSessionMiddleware. Set this value in configuration file !');
    }
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return async (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      try {
        let session: ISession = null;
        if (req.cookies?.ssid) {
          const ssid: string | false = cs.unsign(req.cookies.ssid, this.CoockieSecret);
          if (ssid) {
            session = await this.SessionProvider.restore(ssid);
          }
        }

        if (session) {
          /**
           * If we have session, try to restore user with data from session
           * otherwise try to create guest
           */
          req.storage.User = await DI.resolve<User>('RbacUserFactory', [session.Data.get('User')]);
          req.storage.Session = session;
        } else {
          req.storage.User = DI.resolve<User>('RbacGuestUserFactory');
        }

        next();
      } catch (err) {
        next(err);
      }
    };
  }
  public after(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return null;
  }
}
