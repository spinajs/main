import { ISession, SessionProvider, User, hashSessionId, sessionCookie, sessionCookieName, ISessionCookieConfig } from '@spinajs/rbac';
import { Autoinject, DI, Injectable } from '@spinajs/di';
import 'reflect-metadata';
import * as express from 'express';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import * as cs from 'cookie-signature';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';

/**
 * The secret shipped in `@spinajs/http`'s own default config. Anybody can read
 * it from the package, so a deployment still using it has session cookies that
 * anyone can forge a signature for.
 */
const PUBLIC_DEFAULT_COOKIE_SECRET = '1234adreewD';

@Injectable(ServerMiddleware)
export class RbacMiddleware extends ServerMiddleware {
  @Logger('rbac-session')
  protected Log: Log;

  @Config('http.cookie.secret')
  protected CoockieSecret: string;

  @Config('rbac.session.cookie', {})
  protected SessionCookieConfig: ISessionCookieConfig;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  public async resolve() {
    if (!this.CoockieSecret) {
      throw new Error('http.cookie.secrets is not set, cannot start UserFromSessionMiddleware. Set this value in configuration file !');
    }

    if (this.CoockieSecret === PUBLIC_DEFAULT_COOKIE_SECRET) {
      const message = 'http.cookie.secret is still the public default shipped with @spinajs/http. Session cookie signatures are forgeable by anyone. Set your own secret in the application configuration.';

      // Fatal in production, loud everywhere else: tests and local development
      // legitimately run on the packaged default, and refusing to boot there
      // would only teach people to delete the check.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(message);
      }

      this.Log.warn(message);
    }
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return async (req: sRequest, res: express.Response, next: express.NextFunction) => {
      try {
        let session: ISession | null = null;

        const cookieName = sessionCookieName(this.SessionCookieConfig);

        // `ssid` is signed BY HAND ( see http `_setCoockies` ), so it reaches us
        // unsigned-looking and stays in `req.cookies`. A cookie that was issued
        // through express's own `signed: true` goes out `s:`-prefixed instead,
        // and cookie-parser then hands it over in `req.signedCookies` ALREADY
        // unsigned while deleting it from `req.cookies`. Accept that shape too,
        // so sessions issued by that path are restored rather than dropped.
        const raw = req.cookies?.[cookieName] as string | undefined;
        const ssid: string | false = raw ? cs.unsign(raw, this.CoockieSecret) : (req.signedCookies?.[cookieName] as string | false | undefined) ?? false;

        if (raw && ssid === false) {
          // A present-but-unverifiable cookie is either a mangled client or
          // somebody probing session ids. Hashed, never the raw value.
          this.Log.warn(`Rejected session cookie with an invalid signature`, {
            Session: hashSessionId(raw),
            Ip: req.ip,
          });
        }

        if (ssid) {
          session = await this.SessionProvider.restore(ssid);

          if (!session) {
            this.Log.warn(`Session id presented but not found in the store ( expired or unknown )`, {
              Session: hashSessionId(ssid),
              Ip: req.ip,
            });
          }
        }

        if (session) {
          // Anything rendered for an identified user must not be written to a
          // shared cache, and the session id itself must never sit in one.
          res.setHeader('Cache-Control', 'no-store');

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

          // Sliding renewal: touch the session on every authenticated request.
          // The store recomputes Expiration via the configured strategy and
          // returns true only when it actually changed (sliding modes); under
          // absolute expiration it returns false and performs no write, so we
          // leave the cookie untouched.
          const renewed = await this.SessionProvider.touch(session);
          if (renewed) {
            // Signed by hand and handed to express UNSIGNED, exactly like the
            // login response does through http `_setCoockies`. With express's
            // `signed: true` the value goes out `s:`-prefixed, cookie-parser
            // moves it to `req.signedCookies` and deletes it from `req.cookies`
            // - so every request after the first renewal arrived session-less
            // and failed with `user not authorized or session expired`.
            const cookie = sessionCookie(session, this.SessionCookieConfig);

            res.cookie(cookie.Name, cs.sign(session.SessionId, this.CoockieSecret), {
              ...cookie.Options,
              signed: false,
            } as express.CookieOptions);
          }
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
