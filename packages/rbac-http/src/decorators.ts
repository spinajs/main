import { IAclDescriptor, IAclRoutePermissionDescriptor } from './interfaces';
import { Parameter, Policy, Route } from '@spinajs/http';
import { AclPolicy } from './policies';

export const ACL_CONTROLLER_DESCRIPTOR = Symbol('ACL_CONTROLLER_DESCRIPTOR_SYMBOL');

export type Permission = 'readAny' | 'readOwn' | 'updateAny' | 'updateOwn' | 'deleteAny' | 'deleteOwn' | 'createAny' | 'createOwn';

function descriptor(callback: (controller: IAclDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let metadata: IAclDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, target.prototype || target);
    if (!metadata) {
      metadata = {
        Resource: '',
        Routes: new Map<string, IAclRoutePermissionDescriptor>(),
        Permission: 'readOwn',
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
export function Resource(resource: string, permission: Permission = 'readOwn') {
  return descriptor((metadata: IAclDescriptor, target: any) => {
    Policy(AclPolicy)(target, null, null);

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
export function Permission(permission: Permission = 'readOwn') {
  return descriptor((metadata: IAclDescriptor, target: any, propertyKey: string) => {
    let route: IAclRoutePermissionDescriptor = null;

    if (propertyKey) {
      if (metadata.Routes.has(propertyKey)) {
        route = metadata.Routes.get(propertyKey);
      } else {
        route = {
          Permission: permission,
        };
      }

      metadata.Routes.set(propertyKey, route);
    }

    Policy(AclPolicy)(target, propertyKey, null);
  });
}

export function FromUser() {
  return Route(Parameter('UserArg'));
}
