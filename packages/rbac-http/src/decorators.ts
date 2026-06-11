import { IRbacDescriptor, IRbacRoutePermissionDescriptor } from './interfaces.js';
import { IController, IRoute, Middleware, Parameter, Policy, Route, RouteMiddleware, Request as sRequest, Response } from '@spinajs/http';
import { RbacPolicy } from './policies/RbacPolicy.js';
import { PermissionType } from '@spinajs/rbac';
import * as express from 'express';

/**
 * Global symbol so external packages (e.g. http-swagger) can read the RBAC
 * descriptor via Reflect metadata without importing rbac-http.
 */
export const ACL_CONTROLLER_DESCRIPTOR = Symbol.for('ACL_CONTROLLER_DESCRIPTOR_SYMBOL');

export function setRbacMetadata(target: any, callback: (meta: IRbacDescriptor) => void) {
  let metadata: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, target.prototype || target);
  if (!metadata) {
    metadata = {
      Resource: '',
      Routes: new Map<string, IRbacRoutePermissionDescriptor>(),
      Permission: ['readOwn'],
    };

    Reflect.defineMetadata(ACL_CONTROLLER_DESCRIPTOR, metadata, target.prototype || target);
  }

  if (callback) {
    callback(metadata);
  }
}

function descriptor(callback: (controller: IRbacDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let metadata: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, target.prototype || target);
    if (!metadata) {
      metadata = {
        Resource: '',
        Routes: new Map<string, IRbacRoutePermissionDescriptor>(),
        Permission: ['readOwn'],
      };

      Reflect.defineMetadata(ACL_CONTROLLER_DESCRIPTOR, metadata, target.prototype || target);
    }

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
      if (!metadata.Routes.has(propertyKey)) {
        const route = {
          Permission: permission,
        };
        metadata.Routes.set(propertyKey, route);
      }
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
