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
        let session: ISession | null = null;
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

          // When impersonation is active, session.Data.User is the *target*
          // user. Resolve the original (Impersonator) alongside so downstream
          // code can render banners, audit actions, and end the impersonation.
          const impersonatorUuid = session.Data.get('Impersonator') as string | undefined;
          if (impersonatorUuid) {
            req.storage.Impersonator = await DI.resolve<User>('RbacUserFactory', [impersonatorUuid]);
          }

          const sessionActiveRole = session.Data.get('ActiveRole') as string | undefined;
          req.storage.ActiveRole = sessionActiveRole && req.storage.User.Role.includes(sessionActiveRole)
            ? sessionActiveRole
            : req.storage.User.Role?.[0];
        } else {
          req.storage.User = DI.resolve<User>('RbacGuestUserFactory');
          req.storage.ActiveRole = req.storage.User.Role?.[0];
        }

        next();
      } catch (err) {
        next(err);
      }
    };
  }
  public after(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    return null;
  }
}
