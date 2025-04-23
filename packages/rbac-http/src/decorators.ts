import { IRbacDescriptor, IRbacRoutePermissionDescriptor } from './interfaces.js';
import { Parameter, Policy, Route } from '@spinajs/http';
import { RbacPolicy } from './policies/RbacPolicy.js';
import { PermissionType } from '@spinajs/rbac';

export const ACL_CONTROLLER_DESCRIPTOR = Symbol('ACL_CONTROLLER_DESCRIPTOR_SYMBOL');

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
  return descriptor((metadata: IRbacDescriptor, target: any) => {
    Policy(RbacPolicy)(target, null, null);

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

    Policy(RbacPolicy)(target, propertyKey, null);
  });
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
