import { NewInstance } from '@spinajs/di';
import { AccessDenied, Unauthenticated, authzStorage, parsePermission } from '@spinajs/authz';
import type { Decision, Principal, ResourceRef } from '@spinajs/authz';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

import { domainService } from '../domains.js';
import { routeAccess } from './descriptor.js';
import type { IAccessRule } from './descriptor.js';
import '../storage.js';

/**
 * Decides one `@Access` (design §11.2): a request without a principal, or with an unauthenticated
 * one on a route without `@AllowAnonymous`, is refused 401; several permissions mean any of them;
 * the allowing decision goes to `req.storage.AuthzDecision`; a denial throws `AccessDenied` (403).
 */
@NewInstance()
export class AccessPolicy extends BasePolicy {
  constructor(public readonly rule: IAccessRule) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request, route: IRoute, controller: IController): Promise<void> {
    const principal = req.storage.Principal;
    if (!principal) {
      throw new Unauthenticated('this route needs a principal');
    }
    if (!principal.authenticated && !routeAccess(controller, route.Method).anonymous) {
      throw new Unauthenticated('this route needs an authenticated principal');
    }

    const resource = this.rule.options.resource ? await this.rule.options.resource(req) : undefined;
    const decision = await this.decide(req, principal, resource);

    if (!decision.allowed) {
      throw new AccessDenied(decision);
    }
    req.storage.AuthzDecision = decision;
  }

  protected async decide(req: Request, principal: Principal, resource: ResourceRef | object | undefined): Promise<Decision> {
    const authz = await domainService(this.rule.options.domain ?? 'root');
    let denied: Decision | undefined;

    for (const permission of this.rule.permissions) {
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
