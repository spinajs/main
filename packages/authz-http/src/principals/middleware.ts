import { DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzService } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type * as express from 'express';

import { PrincipalSource } from '../api.js';
import '../storage.js';

/** The principal of a request no source recognised, while `authz.principals.anonymous.enabled` is on. */
export const ANONYMOUS: Principal = Object.freeze({
  type: 'anonymous',
  id: 'anonymous',
  authenticated: false,
  source: 'anonymous',
  attributes: Object.freeze({}),
});

/** Runs after authn-http's AuthnMiddleware (Order 5), which leaves its principal in `req.storage.AuthnPrincipal`. */
export const PRINCIPAL_MIDDLEWARE_ORDER = 10;

/**
 * Resolves the request's principal (design §11.1): the registered `PrincipalSource`s run in ascending
 * `order` and the first non-null answer wins; with none, the anonymous principal when
 * `authz.principals.anonymous.enabled`, else no principal at all. The principal goes to
 * `req.storage.Principal`, the store the action's AsyncLocalStorage runs with, and the root
 * domain preloads it.
 */
@Injectable(ServerMiddleware)
export class PrincipalMiddleware extends ServerMiddleware {
  protected Authz: AuthzService;

  constructor() {
    super();
    this.Order = PRINCIPAL_MIDDLEWARE_ORDER;
  }

  public async resolve(): Promise<void> {
    // authz() is synchronous and throws until the root service has booted, so boot it here (F4).
    this.Authz = (await DI.resolve(AuthzService)) as AuthzService;
  }

  public before(): (req: Request, res: express.Response, next: express.NextFunction) => void {
    return (req, _res, next) => {
      this.attach(req).then(() => next(), next);
    };
  }

  public after(): null {
    return null;
  }

  protected async attach(req: Request): Promise<void> {
    const principal = await this.authenticate(req);
    if (principal) {
      req.storage.Principal = principal;
      await this.Authz.preload(principal);
    }
  }

  protected async authenticate(req: Request): Promise<Principal | null> {
    for (const source of await this.sources()) {
      const principal = await source.authenticate(req);
      if (principal) {
        return principal;
      }
    }

    return this.anonymousEnabled() ? ANONYMOUS : null;
  }

  protected async sources(): Promise<PrincipalSource[]> {
    const sources = (await DI.resolve(Array.ofType(PrincipalSource))) as PrincipalSource[];
    return [...sources].sort((a, b) => a.order - b.order);
  }

  protected anonymousEnabled(): boolean {
    const enabled = DI.get(Configuration)?.get<unknown>(['authz', 'principals', 'anonymous', 'enabled']);
    return enabled !== false;
  }
}
