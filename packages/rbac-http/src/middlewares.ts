import { SessionProvider, User, UserSession } from '@spinajs/rbac';
import { DI } from '@spinajs/di';
import 'reflect-metadata';
import * as express from 'express';
import { Configuration } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import { assert } from 'console';
import { DateTime } from 'luxon';

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
