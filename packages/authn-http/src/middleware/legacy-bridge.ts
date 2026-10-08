import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { Principal } from '@spinajs/authn/contracts';
import type * as express from 'express';

import type { ITokenAuthInfo } from '../interfaces.js';

// Declares the 2.x request keys (User, Impersonator) on req.storage.
import '../interfaces.js';

type LegacyUser = NonNullable<Request['storage']['User']>;

// The DI keys @spinajs/users registers its 2.x user loaders under.
const USER_FACTORY = 'RbacUserFactory';
const GUEST_FACTORY = 'RbacGuestUserFactory';

/**
 * The 2.x policies only test it for truthiness; app row scoping reads Profile. Only authn-token's agent principal names
 * its token row (TokenService gives an agent the token's id); any other principal leaves Uuid empty.
 */
function tokenAuthOf(principal: Principal): ITokenAuthInfo {
  const profile = principal.attributes?.profile;
  return Object.freeze({
    Uuid: principal.type === 'agent' && principal.authn?.method === 'token' ? principal.id : '',
    ...(typeof profile === 'string' && profile !== '' ? { Profile: profile } : {}),
  });
}

const hasSessionHandle = (principal: Principal): boolean => typeof principal.authn?.sessionHandle === 'string' && principal.authn.sessionHandle !== '';

/**
 * Order 6, after AuthnMiddleware. Fills the 2.x request keys that 2.x consumers still read (users-http, the 2.x
 * policies, the users ORM permission checks) from req.storage.AuthnPrincipal alone. It authenticates nothing, reads no
 * cookie or header and writes no store:
 * - User: the principal's user (the principal itself, or onBehalfOf) through users' RbacUserFactory; otherwise the 2.x
 *   guest, as 2.x did without a session, because the users ORM checks skip every row check for a request without a User;
 * - Impersonator: while impersonating, the impersonator, or a marker when it cannot be loaded;
 * - TokenAuth: a marker for a per-request credential (a principal without a session handle), with the token's profile
 *   (principal.attributes.profile, set by TokenStrategy) when it has one.
 *
 * It never sets Session or ActiveRole, so a route behind the 2.x LoggedPolicy, AuthorizedPolicy or RbacPolicy answers
 * 401 until its lane moves it to the 3.0 policies.
 *
 * @deprecated 3.0: read req.storage.AuthnPrincipal (AuthnMiddleware) and use Authenticated and @Identity(). R1 deletes it.
 */
@Injectable(ServerMiddleware)
export class LegacyStorageBridge extends ServerMiddleware {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Logger('authn-http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 6;
  }

  public before(): (req: Request, res: express.Response, next: express.NextFunction) => void {
    return async (req: Request, _res: express.Response, next: express.NextFunction) => {
      try {
        await this.bridge(req);
      } catch (err) {
        return next(err);
      }
      next();
    };
  }

  public after(): null {
    return null;
  }

  protected async bridge(req: Request): Promise<void> {
    const storage = req.storage;
    const found = storage.AuthnPrincipal;
    const principal = found?.authenticated === true ? found : null;
    const owner = principal ? principal.onBehalfOf ?? principal : null;

    const user = (owner?.type === 'user' ? await this.userOf(owner.id) : undefined) ?? (await this.guest());
    if (user !== undefined) storage.User = user;

    const impersonator = principal?.authn?.impersonator;
    if (impersonator) {
      storage.Impersonator = (impersonator.type === 'user' ? await this.userOf(impersonator.id) : undefined) ?? (Object.freeze({ Uuid: impersonator.id }) as unknown as LegacyUser);
    }

    if (principal && !hasSessionHandle(principal)) storage.TokenAuth = tokenAuthOf(principal);
  }

  /** The user's 2.x model, or undefined when users is not loaded or cannot load an active user of that id. */
  protected async userOf(id: string): Promise<LegacyUser | undefined> {
    if (!this.Container.hasRegistered(USER_FACTORY)) return undefined;
    try {
      return await this.Container.resolve<Promise<LegacyUser>>(USER_FACTORY, [id]);
    } catch (err) {
      this.Log.warn(`No 2.x user for an authenticated principal: ${err instanceof Error ? err.name : typeof err}`, { Principal: id });
      return undefined;
    }
  }

  /** A guest factory that throws fails the request: without a User the users ORM checks would skip their row checks. */
  protected async guest(): Promise<LegacyUser | undefined> {
    return this.Container.hasRegistered(GUEST_FACTORY) ? await this.Container.resolve<LegacyUser>(GUEST_FACTORY) : undefined;
  }
}
