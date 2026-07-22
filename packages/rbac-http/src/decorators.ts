import { IRbacDescriptor, IRbacRoutePermissionDescriptor } from './interfaces.js';
import { IController, IRoute, Middleware, Parameter, Policy, Route, RouteMiddleware, Request as sRequest, Response } from '@spinajs/http';
import { RbacPolicy } from './policies/RbacPolicy.js';
import { PermissionType } from '@spinajs/rbac';
import { getInheritedDescriptor } from '@spinajs/di';
import * as express from 'express';

/**
 * Global symbol so external packages (e.g. http-swagger) can read the RBAC
 * descriptor via Reflect metadata without importing rbac-http.
 */
export const ACL_CONTROLLER_DESCRIPTOR = Symbol.for('ACL_CONTROLLER_DESCRIPTOR_SYMBOL');

/**
 * Permission a controller gets when neither it nor any ancestor declares one
 * ( eg. a controller using route level `@Permission` only ).
 */
const DEFAULT_CONTROLLER_PERMISSION: PermissionType[] = ['readOwn'];

/**
 * NOTE: `Permission` starts EMPTY here, unlike the documented default, and
 * `rbacDescriptor()` fills the default in afterwards. The collapse in
 * `getInheritedDescriptor` seeds itself with this object and CONCATENATES
 * arrays, so seeding `['readOwn']` would make every subclass inherit
 * `['readOwn', ...parent permission]` - granting more than the parent, which is
 * the one direction a permission list must never drift in.
 */
function createDefaultRbacDescriptor(): IRbacDescriptor {
  return {
    Resource: '',
    Routes: new Map<string, IRbacRoutePermissionDescriptor>(),
    Permission: [],
  };
}

/**
 * The descriptor OWNED by the decorated class, pre-populated with everything it
 * inherits.
 *
 * `Reflect.getMetadata` walks the prototype chain, so a controller subclass used
 * to find - and mutate - its parent's descriptor: an application declaring
 * `@Resource` on a subclass rewrote the ACL resource and permissions of the
 * package controller it extends. `getInheritedDescriptor` stores own metadata
 * per class instead, keyed by identity.
 *
 * Stored on the prototype ( `target.prototype || target` covers both the class
 * and the member decorator forms ) because that is where RbacPolicy and
 * http-swagger reach it from, off a controller INSTANCE.
 */
function rbacDescriptor(target: any): IRbacDescriptor {
  const controller = target.prototype || target;

  // True only for the very first decorator that touches THIS class, since
  // getInheritedDescriptor stores own metadata as soon as it is called.
  const isFirstDecorator = !Reflect.getOwnMetadata(ACL_CONTROLLER_DESCRIPTOR, controller);
  const metadata = getInheritedDescriptor<IRbacDescriptor>(controller, ACL_CONTROLLER_DESCRIPTOR, createDefaultRbacDescriptor);

  // Nothing declared and nothing inherited - see createDefaultRbacDescriptor for
  // why the default cannot simply be part of the seed. Only on creation: later
  // decorators would otherwise refill a permission list a class deliberately
  // emptied ( eg. `@Resource('r', [])` ). Optional chaining because the symbol
  // is global - a foreign package may have stored a differently shaped
  // descriptor on this prototype and decoration must not throw over it.
  if (isFirstDecorator && !metadata.Permission?.length) {
    metadata.Permission = [...DEFAULT_CONTROLLER_PERMISSION];
  }

  return metadata;
}

export function setRbacMetadata(target: any, callback: (meta: IRbacDescriptor) => void) {
  const metadata = rbacDescriptor(target);

  if (callback) {
    callback(metadata);
  }
}

function descriptor(callback: (controller: IRbacDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    const metadata = rbacDescriptor(target);

    if (callback) {
      callback(metadata, target, propertyKey, indexOrDescriptor);
    }
  };
}

/**
 * Assign resource for controller
 *
 * @param resource - name of resource
 * @param permission - default permission. When omitted, the base controller's
 *                     permission is kept ( `readOwn` if there is nothing to
 *                     inherit ), so renaming a resource in a subclass does not
 *                     silently change what it grants.
 */
export function Resource(resource: string, permission?: PermissionType[]) {
  return descriptor((metadata: IRbacDescriptor) => {
    metadata.Resource = resource;

    // ASSIGNED, never merged, and only when the argument was actually passed.
    // Assigning is what lets an application NARROW a package controller -
    // concatenating would grant the union of both lists, and a longer
    // permission list grants more. Omitting the argument says nothing about
    // permissions, so whatever was collapsed from the base controller stands.
    // Copied because the array belongs to the call site, which is free to keep
    // mutating it.
    if (permission) {
      metadata.Permission = [...permission];
    }
  });
}

/**
 *
 * Assigns permission for controller route
 *
 * @param permission - permission to set
 */
export function Permission(permission: PermissionType[] = ['readOwn']) {
  return descriptor((metadata: IRbacDescriptor, target: any, propertyKey: string) => {
    if (propertyKey) {
      // Always set, never guarded by `has()`: routes are inherited per member
      // name now, so a guard would make a subclass's @Permission on an inherited
      // route silently do nothing and leave the package controller's permission
      // in force. Setting a FRESH entry is also what keeps the inherited entries
      // - which the collapse shares by reference with the parent - from being
      // rewritten here.
      metadata.Routes.set(propertyKey, {
        Permission: permission,
      });
    }

    Policy(RbacPolicy)(target, propertyKey, undefined);
  });
}

/**
 * Disables RbacModelPermissionMiddleware for controller action ( or whole controller when applied to class ).
 *
 * Use for actions that are assumed safe to execute - rbac permission
 * constraints will NOT be injected into query builders for queries
 * executed within the action. Route-level permission checks ( RbacPolicy )
 * are NOT affected by this decorator.
 */
export function SkipModelPermission() {
  return Middleware(
    class extends RouteMiddleware {
      public isEnabled(_route: IRoute, _controller: IController): boolean {
        return true;
      }
      public async onBefore(req: express.Request, _res: express.Response, _route: IRoute, _controller: IController): Promise<void> {
        (req as sRequest).storage.SkipModelPermissionCheck = true;
      }
      public async onResponse(_response: Response, _route: IRoute, _controller: IController): Promise<void> {}
      public async onAfter(_req: express.Request, _res: express.Response, _route: IRoute, _controller: IController): Promise<void> {}
    },
  );
}

/**
 * Retrieves user from session if is logged in
 */
export function User() {
  return Route(Parameter('UserArg'));
}

/**
 * Extract args from user session
 */
export function FromSession() {
  return Route(Parameter('SessionArg'));
}

export function Session(){ 
  return Route(Parameter("CurrentSessionArg"));
}
