import { NewInstance } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { parsePermission } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';
import { BasePolicy, Middleware, Route, RouteMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IPolicyGroup, IRoute, Request, Response } from '@spinajs/http';
import type * as express from 'express';

import type { AccessOptions } from '../api.js';
import { auditUnscoped } from '../domains.js';
import { ACCESS_CLASS, ownAccessDescriptor, routeAccess, routeDomain } from './descriptor.js';
import { AccessPolicy } from './policy.js';
import '../storage.js';

/**
 * Guards a route, or every route of a controller, with authorization (design §11.2). One policy
 * group: `AccessPolicy` AND the `also` policies (B23), as 2.x `@Permission` placed `RbacPolicy`;
 * other `@Policy` groups at the same place stay alternatives (OR), and a class-level `@Access`
 * narrows every route (http combines the class and route scopes with AND).
 */
export function Access(permission: Permission | readonly Permission[], opts?: AccessOptions): ClassDecorator & MethodDecorator {
  const permissions: Permission[] = typeof permission === 'string' ? [permission] : [...permission];
  if (permissions.length === 0) {
    throw new Error('@Access needs at least one permission');
  }
  // A malformed name fails when the controller module loads, not on the first request.
  permissions.forEach((p) => parsePermission(p));

  const rule = { permissions: Object.freeze(permissions), options: Object.freeze({ ...(opts ?? {}) }) };

  return Route((controller: IControllerDescriptor, route: IRoute, target: object, propertyKey?: string | symbol) => {
    ownAccessDescriptor(target).Access.set(propertyKey ?? ACCESS_CLASS, rule);

    const group: IPolicyGroup = [{ Type: AccessPolicy, Options: [rule] }, ...(rule.options.also ?? []).map((Type) => ({ Type: Type as Constructor<BasePolicy>, Options: [] }))];
    (route ? route.Policies : controller.Policies).push(group);
  }) as ClassDecorator & MethodDecorator;
}

/** Lets an unauthenticated principal (anonymous) pass the authentication part of `@Access`; without a principal the route still answers 401. */
export function AllowAnonymous(): ClassDecorator & MethodDecorator {
  return ((target: object, propertyKey?: string | symbol) => {
    ownAccessDescriptor(target).Anonymous.set(propertyKey ?? ACCESS_CLASS, true);
  }) as ClassDecorator & MethodDecorator;
}

/**
 * Sets `req.storage.Unscoped` for the action, so the ORM applies no residual to the route's
 * queries, and audits the bypass (kind `unscoped`) in the route's domain (B09). Runs after the
 * policies: a refused request is no bypass.
 */
@NewInstance()
export class UnscopedMiddleware extends RouteMiddleware {
  constructor(public readonly reason: string) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  public async onBefore(req: express.Request, _res: express.Response, route: IRoute, controller: IController): Promise<void> {
    const r = req as Request;
    r.storage.Unscoped = this.reason;
    const principal = r.storage.Principal;
    await auditUnscoped(routeDomain(routeAccess(controller, route.Method)), {
      kind: 'unscoped',
      principal: principal ? { type: principal.type, id: principal.id } : { type: 'unattended', id: 'unattended' },
      reason: this.reason,
    });
  }

  public async onResponse(_response: Response): Promise<void> {}

  public async onAfter(): Promise<void> {}
}

export function Unscoped(reason: string): MethodDecorator {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('@Unscoped needs a reason');
  }
  const middleware = Middleware(UnscopedMiddleware, reason);

  return ((target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    ownAccessDescriptor(target).Unscoped.set(propertyKey, reason);
    middleware(target, propertyKey, descriptor);
  }) as MethodDecorator;
}
