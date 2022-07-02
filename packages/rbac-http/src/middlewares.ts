import { ServerMiddleware } from './../../http/src/interfaces';
import { SessionProvider, User, UserSession } from '@spinajs/rbac';
import { Autoinject, DI } from '@spinajs/di';
import 'reflect-metadata';
import * as express from 'express';
import { Config, Configuration } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import { assert } from 'console';
import { DateTime } from 'luxon';
import '@spinajs/http';

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
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.cookies.ssid) {
        const ssid: string | false = cs.unsign(req.cookies.ssid, this.CoockieSecret);
        if (ssid) {
          const session = (await this.SessionProvider.restoreSession(ssid)) as UserSession;
          if (session) {
            req.User = new User(session.Data);
            const liveTimeDiff = session.Expiration.diff(DateTime.now());
            if (liveTimeDiff.minutes < 30) {
              await this.SessionProvider.refreshSession(session);
            }
          }
        } else {
        }
      }
    };
  }
  public after(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return null;
  }
}

/**
 * global express middleware that loads user from session
 */
export function UserFromSession() {
  const wrapper = async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.cookies.ssid) {
      const secureKey = DI.get(Configuration).get<string>('http.cookie.secret');

      if (!secureKey) {
        next();
        assert(secureKey, 'coockie secure key should be set');
        return;
      }

      const ssid: string | false = cs.unsign(req.cookies.ssid, secureKey);
      if (ssid) {
        const sessionProvider = DI.has(SessionProvider) ? DI.get(SessionProvider) : await DI.resolve(SessionProvider);
        const session = (await sessionProvider.restoreSession(ssid)) as UserSession;
        if (session) {
          req.User = new User(session.Data);
          const liveTimeDiff = session.Expiration.diff(DateTime.now());
          if (liveTimeDiff.minutes < 30) {
            await sessionProvider.refreshSession(session);
          }
        }
      } else {
        req.User = null;
      }
    }

    next();
  };

  Object.defineProperty(wrapper, 'name', {
    value: 'userFromSession',
    writable: true,
  });

  return wrapper;
}
