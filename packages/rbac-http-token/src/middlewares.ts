import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';
import { ErrorCode } from '@spinajs/exceptions';
import { User } from '@spinajs/rbac';

import { validateToken, touchToken } from './actions.js';
import './interfaces.js';

/**
 * `Authorization: Bearer <token>`. RFC 7235 makes the scheme name
 * case-insensitive, and clients do send `bearer`.
 */
const BEARER_SCHEME = /^bearer\s+/i;

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
          // Deliberately vague towards the client; specific in the log. The uuid
          // is what makes a rejection actionable ( "which key broke" ) and is
          // safe to write down - `validateToken` attaches it as `data.token` on
          // every failure past the lookup. The presented plaintext is NEVER
          // logged, here or anywhere else.
          const data = err instanceof ErrorCode ? (err.data as { token?: string } | undefined) : undefined;
          this.Log.warn(`Access token rejected: ${(err as Error).message}`, { Ip: req.ip, Token: data?.token });
          return next();
        }

        req.storage.User = this.narrowRoles(result.User, result.EffectiveRoles);
        req.storage.ActiveRole = result.EffectiveRoles[0];
        req.storage.TokenAuth = { Uuid: result.Token.Uuid };

        // Token-authenticated responses must never land in a shared cache.
        res.setHeader('Cache-Control', 'no-store');

        // Fire-and-forget throttled usage stamp. A non-Error rejection has no
        // `.message`; reading one off it would throw inside the handler and
        // surface as an unhandled rejection.
        void touchToken(result.Token, this.LastUsedUpdateInterval).catch((err: unknown) => this.Log.warn(`Failed to update token LastUsedAt: ${err instanceof Error ? err.message : String(err)}`, { Token: result.Token.Uuid }));

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
   * Narrows the loaded owner to the token's effective roles WITHOUT letting the
   * narrowing reach the database.
   *
   * `Role` is a real `@Set()` column, and this very instance is what controllers
   * receive through the `@User()` route argument. `update()` writes whatever
   * differs from the model's snapshot, so a controller doing an unrelated edit
   * ( "change my login" ) and calling `.update()` would silently persist the
   * narrowed list - permanently stripping every role the token did not carry.
   *
   * Re-taking the snapshot right after the narrowing makes it invisible to that
   * diff: the instance then behaves exactly like a freshly loaded row whose roles
   * happen to be the effective ones, and a later `.update()` writes only what the
   * controller itself changed. The full instance is kept rather than copied so
   * that `Id`, `Password`, the `Metadata` relation and the prototype accessors
   * ( `IsBanned`, `can()` ) all survive - `dehydrate()` drops the `@Hidden()`
   * columns, so a dehydrate/rehydrate copy would arrive without `Id`.
   *
   * `takeSnapshot()` also discards the relation baselines, which the orm's
   * subject builder needs to tell an already-persisted related row from a new
   * one, so they are recorded again immediately.
   */
  protected narrowRoles(user: User, roles: string[]): User {
    user.Role = roles;
    user.takeSnapshot();

    for (const [name] of user.ModelDescriptor?.Relations ?? []) {
      user.snapshotRelation(name);
    }

    return user;
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
    if (auth && BEARER_SCHEME.test(auth)) {
      return auth.replace(BEARER_SCHEME, '').trim() || null;
    }

    return header(this.HeaderName.toLowerCase())?.trim() || null;
  }
}
