import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';

import { validateToken, touchToken } from './actions.js';
import './interfaces.js';

/**
 * Authenticates requests carrying an access token in `Authorization: Bearer`
 * or the configured fallback header. Runs AFTER RbacMiddleware ( Order 0 )
 * so a session, when present, always wins - a request cannot mix both.
 *
 * On success `req.storage.User` carries the owner with Role narrowed to the
 * token's effective roles, so every downstream permission check ( RbacPolicy
 * helpers, orm rbac query middleware, ownership ) works unchanged.
 *
 * Never throws: an invalid token leaves the request as guest and lets the
 * route's policy produce the rejection.
 */
@Injectable(ServerMiddleware)
export class TokenAuthMiddleware extends ServerMiddleware {
  @Logger('rbac-http-token')
  protected Log: Log;

  @Config('rbac.token.headerName', { defaultValue: 'x-api-key' })
  protected HeaderName: string;

  @Config('rbac.token.lastUsedUpdateInterval', { defaultValue: 60 })
  protected LastUsedUpdateInterval: number;

  constructor() {
    super();
    // After RbacMiddleware ( Order 0 ): session auth takes precedence.
    this.Order = 1;
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return async (req: sRequest, res: express.Response, next: express.NextFunction) => {
      try {
        // Session user already authenticated - tokens do not apply.
        if (req.storage?.Session) {
          return next();
        }

        const plaintext = this.extract(req);
        if (!plaintext) {
          return next();
        }

        let result;
        try {
          result = await validateToken(plaintext);
        } catch (err) {
          // Deliberately vague towards the client; specific in the log.
          this.Log.warn(`Access token rejected: ${(err as Error).message}`, { Ip: (req as any).ip });
          return next();
        }

        // Narrowed role list is what makes the whole rbac stack token-aware.
        result.User.Role = result.EffectiveRoles;

        req.storage.User = result.User;
        req.storage.ActiveRole = result.EffectiveRoles[0];
        req.storage.TokenAuth = { Uuid: result.Token.Uuid };

        // Token-authenticated responses must never land in a shared cache.
        res.setHeader('Cache-Control', 'no-store');

        // Fire-and-forget throttled usage stamp.
        void touchToken(result.Token, this.LastUsedUpdateInterval).catch((err) => this.Log.warn(`Failed to update token LastUsedAt: ${err.message}`, { Token: result.Token.Uuid }));

        next();
      } catch (err) {
        next(err);
      }
    };
  }

  public after(): null {
    return null;
  }

  /**
   * Bearer scheme first, configured fallback header second.
   */
  protected extract(req: sRequest): string | null {
    // A header sent twice arrives as an array. Anything that is not a single
    // string is malformed and has to read as "no token presented" - calling
    // `.startsWith` / `.trim` on it would throw, and this middleware is
    // contractually not allowed to turn a bad request into a 500.
    const header = (name: string): string | null => {
      const value = req.headers?.[name];
      return typeof value === 'string' ? value : null;
    };

    const auth = header('authorization');
    if (auth?.startsWith('Bearer ')) {
      return auth.substring('Bearer '.length).trim() || null;
    }

    return header(this.HeaderName.toLowerCase())?.trim() || null;
  }
}
