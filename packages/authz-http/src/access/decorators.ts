import { NewInstance } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { AuthzConfigError, parsePermission } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';
import { BasePolicy, Middleware, Route, RouteMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IPolicyGroup, IRoute, Request, Response } from '@spinajs/http';
import type * as express from 'express';

import type { AccessOptions } from '../api.js';
import { auditUnscoped } from '../domains.js';
import { ACCESS_CLASS, ownAccessDescriptor, routeAccess, routeDomain } from './descriptor.js';
import type { AccessKey, IAccessRule } from './descriptor.js';
import { AccessPolicy } from './policy.js';
import { AuthzFieldsMiddleware } from '../fields.js';
import '../storage.js';

// Keys each class declared itself, to tell a second @Access on one member from an override of an inherited one.
const declared = new WeakMap<object, Set<AccessKey>>();

function declareOnce(target: object, key: AccessKey): void {
  const proto = (target as { prototype?: object }).prototype ?? target;
  const keys = declared.get(proto) ?? new Set<AccessKey>();
  if (keys.has(key)) {
    const owner = (proto as { constructor: { name: string } }).constructor.name;
    throw new Error(`@Access is declared twice on ${owner}${key === ACCESS_CLASS ? '' : `.${String(key)}`}`);
  }
  declared.set(proto, keys.add(key));
}

/**
 * Guards a route, or every route of a controller, with authorization (design §11.2). One policy
 * group: `AccessPolicy` AND the `also` policies (B23), as 2.x `@Permission` placed `RbacPolicy`;
 * other `@Policy` groups at the same place stay alternatives (OR), and a class-level `@Access`
 * narrows every route (http combines the class and route scopes with AND). On a subclass it
 * replaces the inherited `@Access` group of that place instead of adding an alternative to it.
 */
export function Access(permission: Permission | readonly Permission[], opts?: AccessOptions): ClassDecorator & MethodDecorator {
  const permissions: Permission[] = typeof permission === 'string' ? [permission] : [...permission];
  if (permissions.length === 0) {
    throw new Error('@Access needs at least one permission');
  }
  // A malformed name fails when the controller module loads, not on the first request.
  permissions.forEach((p) => parsePermission(p));

  const rule: IAccessRule = { permissions: Object.freeze(permissions), options: Object.freeze({ ...(opts ?? {}) }) };

  return Route((controller: IControllerDescriptor, route: IRoute, target: object, propertyKey?: string | symbol) => {
    const key = propertyKey ?? ACCESS_CLASS;
    declareOnce(target, key);
    ownAccessDescriptor(target).Access.set(key, rule);

    const groups = route ? route.Policies : controller.Policies;
    const inherited = groups.findIndex((g) => g[0]?.Type === AccessPolicy);
    if (inherited >= 0) {
      groups.splice(inherited, 1);
    }
    // The policy reads the rule from the descriptor at request time, so swagger, the boot refs and the check agree.
    const group: IPolicyGroup = [{ Type: AccessPolicy, Options: [route ? 'route' : 'class'] }, ...(rule.options.also ?? []).map((Type) => ({ Type: Type as Constructor<BasePolicy>, Options: [] }))];
    groups.push(group);

    const middlewares = route ? route.Middlewares : controller.Middlewares;
    if (rule.options.fields === 'filter' && !middlewares.some((m) => m.Type === AuthzFieldsMiddleware)) {
      middlewares.push({ Type: AuthzFieldsMiddleware, Options: [] });
    }
  }) as ClassDecorator & MethodDecorator;
}

/** Lets an unauthenticated principal (anonymous) pass the authentication part of `@Access`; without a principal the route still answers 401. */
export function AllowAnonymous(): ClassDecorator & MethodDecorator {
  return ((target: object, propertyKey?: string | symbol) => {
    ownAccessDescriptor(target).Anonymous.set(propertyKey ?? ACCESS_CLASS, true);
  }) as ClassDecorator & MethodDecorator;
}

/**
 * Leaves the route's body input as the caller sent it: no `fields.write` and no `fields.neverRead`
 * filter. For routes whose body legitimately carries such fields, e.g. an admin creating a user
 * with a password; the reason documents why.
 */
export function UnfilteredInput(reason: string): ClassDecorator & MethodDecorator {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('@UnfilteredInput needs a reason');
  }
  return ((target: object, propertyKey?: string | symbol) => {
    ownAccessDescriptor(target).UnfilteredInput.set(propertyKey ?? ACCESS_CLASS, reason);
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

  /** Called when http registers the route: an unguarded route must not run unscoped, so registration fails. */
  public isEnabled(route: IRoute, controller: IController): boolean {
    const access = routeAccess(controller, route.Method);
    if (!access.route && !access.controller) {
      throw new AuthzConfigError(`@Unscoped on ${controller.constructor.name}.${String(route.Method)} needs an @Access on the route or its class`);
    }
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
