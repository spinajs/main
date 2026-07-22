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
  const metadata = getInheritedDescriptor<IRbacDescriptor>(target.prototype || target, ACL_CONTROLLER_DESCRIPTOR, createDefaultRbacDescriptor);

  // Nothing declared and nothing inherited - see createDefaultRbacDescriptor for
  // why the default cannot simply be part of the seed.
  if (metadata.Permission.length === 0) {
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
 * @param permission - default permission
 */
export function Resource(resource: string, permission: PermissionType[] = ['readOwn']) {
  return descriptor((metadata: IRbacDescriptor) => {
    // Both fields are ASSIGNED, never merged: a subclass declaring @Resource
    // replaces what it inherited. `permission` has a default argument, so at
    // this point a declared `['readOwn']` is indistinguishable from an omitted
    // one - assigning makes both mean the same thing, "this class grants
    // readOwn". Concatenating instead would let an application that tries to
    // NARROW a package controller end up granting the union of both lists.
    metadata.Resource = resource;
    metadata.Permission = permission;
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
