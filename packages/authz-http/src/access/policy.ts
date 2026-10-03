import { NewInstance } from '@spinajs/di';
import { AccessDenied, AuthzConfigError, Unauthenticated, authzStorage, parsePermission } from '@spinajs/authz';
import type { Decision, Principal, ResourceRef } from '@spinajs/authz';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

import { domainService } from '../domains.js';
import { routeAccess } from './descriptor.js';
import type { IAccessRule } from './descriptor.js';
import '../storage.js';

export type AccessScope = 'route' | 'class';

/**
 * Decides the `@Access` of its scope (design §11.2), read from the controller's descriptor at
 * request time: a request without a principal, or with an unauthenticated one on a route without
 * `@AllowAnonymous`, is refused 401; several permissions mean any of them; a denial throws
 * `AccessDenied` (403). The allowing decision of the route's own `@Access` (else the class's) goes
 * to `req.storage.AuthzDecision`.
 */
@NewInstance()
export class AccessPolicy extends BasePolicy {
  constructor(public readonly scope: AccessScope) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request, route: IRoute, controller: IController): Promise<void> {
    const access = routeAccess(controller, route.Method);
    const rule = this.scope === 'route' ? access.route : access.controller;
    if (!rule) {
      throw new AuthzConfigError(`AccessPolicy on ${controller.constructor.name}.${String(route.Method)} finds no ${this.scope} @Access`);
    }

    const principal = req.storage.Principal;
    if (!principal) {
      throw new Unauthenticated('this route needs a principal');
    }
    if (!principal.authenticated && !access.anonymous) {
      throw new Unauthenticated('this route needs an authenticated principal');
    }

    const resource = rule.options.resource ? await rule.options.resource(req) : undefined;
    const decision = await this.decide(req, rule, principal, resource);

    if (!decision.allowed) {
      throw new AccessDenied(decision);
    }
    if (rule === (access.route ?? access.controller)) {
      req.storage.AuthzDecision = decision;
    }
  }

  protected async decide(req: Request, rule: IAccessRule, principal: Principal, resource: ResourceRef | object | undefined): Promise<Decision> {
    const authz = await domainService(rule.options.domain ?? 'root');
    let denied: Decision | undefined;

    for (const permission of rule.permissions) {
      // In the request's store, so the check shares its per-request cache with the action's.
      const decision = await authzStorage().run(req.storage as unknown as Record<string, unknown>, () => authz.check({ principal, permission, resource: resource ?? { type: parsePermission(permission).resource } }));
      if (decision.allowed) {
        return decision;
      }
      denied ??= decision;
    }

    return denied!;
  }
}
