import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthzConfigError, AuthzService, authzStorage } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import type * as express from 'express';

import { PrincipalSource } from '../api.js';
import { LinkPrincipalSource } from './link-source.js';
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
 * domain preloads it in that store.
 */
@Injectable(ServerMiddleware)
export class PrincipalMiddleware extends ServerMiddleware {
  @Logger('authz-http')
  protected Log: Log;

  // The schema has no default for this key; unset and null mean on.
  @Config('authz.principals.anonymous.enabled', { defaultValue: true })
  protected AnonymousEnabled: boolean;

  private authz: Promise<AuthzService> | undefined;

  constructor() {
    super();
    this.Order = PRINCIPAL_MIDDLEWARE_ORDER;
  }

  public async resolve(): Promise<void> {
    // The http server resolves its middlewares before the controllers register, and the root
    // boot checks the @Access permissions of the registered controllers (B02): boot once it listens.
    await super.resolve();
    DI.RootContainer.once('http.server.listening', this.onListening);
  }

  public async dispose(): Promise<void> {
    DI.RootContainer.removeListener('http.server.listening', this.onListening);
    await super.dispose();
  }

  // The server swallows a listener's errors, so a root that cannot boot stops it: a bad authz config must not serve.
  private readonly onListening = (server?: unknown): void => {
    this.rootService().catch((err: unknown) => {
      this.Log.error(err as Error, 'the root authz domain failed to boot; stopping the http server');
      const stop = (server as { stop?: () => Promise<void> } | undefined)?.stop;
      if (typeof stop === 'function') stop.call(server).catch(() => undefined);
    });
  };

  public before(): (req: Request, res: express.Response, next: express.NextFunction) => void {
    return (req, _res, next) => {
      this.attach(req).then(() => next(), next);
    };
  }

  public after(): null {
    return null;
  }

  /** The root AuthzService, booted once; `authz()` works in actions after it. */
  protected rootService(): Promise<AuthzService> {
    this.authz ??= (DI.resolve(AuthzService) as Promise<AuthzService>).catch((err: unknown) => {
      this.authz = undefined;
      throw err;
    });
    return this.authz;
  }

  protected async attach(req: Request): Promise<void> {
    const authz = await this.rootService();
    const principal = await this.authenticate(req);
    if (principal) {
      req.storage.Principal = principal;
      // In the request's store, so what models keep per request at preload reaches the checks.
      await authzStorage().run(req.storage as unknown as Record<string, unknown>, () => authz.preload(principal));
    }
  }

  /**
   * First non-null of the plain sources; then a link source may replace it, with it as the link's
   * companion (left in req.storage.Principal for the link source to read).
   */
  protected async authenticate(req: Request): Promise<Principal | null> {
    const sources = await this.sources();
    let principal: Principal | null = null;

    for (const source of sources.filter((s) => !(s instanceof LinkPrincipalSource))) {
      principal = await this.ask(source, req);
      if (principal) break;
    }

    if (principal) req.storage.Principal = principal;
    for (const source of sources.filter((s) => s instanceof LinkPrincipalSource)) {
      const link = await this.ask(source, req);
      if (link) {
        principal = link;
        break;
      }
    }

    return principal ?? (this.AnonymousEnabled !== false ? ANONYMOUS : null);
  }

  protected async ask(source: PrincipalSource, req: Request): Promise<Principal | null> {
    const principal = await source.authenticate(req);
    // SYSTEM and UNATTENDED come only from runAs, @Job and @Unscoped (design §14.1).
    if (principal && (principal.type === 'system' || principal.type === 'unattended')) {
      throw new AuthzConfigError(`principal source ${source.name} returned a ${principal.type} principal`);
    }
    return principal;
  }

  protected async sources(): Promise<PrincipalSource[]> {
    const sources = (await DI.resolve(Array.ofType(PrincipalSource))) as PrincipalSource[];
    return [...sources].sort((a, b) => a.order - b.order);
  }
}
