import { AccessControl, Permission } from 'accesscontrol';
import { BasePolicy, IController, IRoute, ServerError, Request as sRequest } from '@spinajs/http';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ACL_CONTROLLER_DESCRIPTOR } from '../decorators.js';
import { IRbacDescriptor } from '../interfaces.js';
import { DI } from '@spinajs/di';
import { PermissionType, User } from '@spinajs/rbac';

/**
 * Checks if user is logged, authorized & have proper permissions
 */
export class RbacPolicy extends BasePolicy {
  protected Ac: AccessControl;

  constructor() {
    super();

    this.Ac = DI.get('AccessControl');
  }

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: sRequest, action: IRoute, instance: IController) {
    const descriptor: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);
    let permission = descriptor.Permission ?? [];

    if (descriptor.Routes.has(action.Method)) {
      //req.storage.PermissionScope = descriptor.Routes.get(action.Method).Permission;
      if (req.headers['x-permission-scope']) {
        req.storage.PermissionScope = req.headers['x-permission-scope'] as PermissionType ?? null;
      }
      permission = descriptor.Routes.get(action.Method).Permission ?? [];
    }

    // check if route has its own permission
    if (!descriptor || !descriptor.Permission || descriptor.Permission.length === 0) {
      throw new ServerError(`no route permission or resources assigned`);
    }

    if (!req.storage || !req.storage.Session || !req.storage.User || !req.storage.Session.Data.get('Authorized')) {
      throw new AuthenticationFailed('user not logged or session expired');
    }

    if (!permission.some(p => checkRoutePermission(req, descriptor.Resource, p).granted)) {
      throw new Forbidden(`role(s) ${req.storage.User.Role} does not have permission ${permission} for resource ${descriptor.Resource}`);
    }
  }
}

export function checkRbacPermission(role: string | string[], resource: string, permission: string): Permission {
  const ac = DI.get<AccessControl>('AccessControl');
  return (ac.can(role) as any)[permission](resource);
}

export function checkUserPermission(user: User, resource: string, permission: string): Permission {
  const ac = DI.get<AccessControl>('AccessControl');

  if (!user) {
    return null;
  }

  return (ac.can(user.Role) as any)[permission](resource);
}

export function checkRoutePermission(req: sRequest, resource: string, permission: string): Permission {
  if (!req.storage || !req.storage.User) {
    return null;
  }

  return checkUserPermission(req.storage.User, resource, permission);
}
