import { AccessControl, Permission } from 'accesscontrol';
import { BasePolicy, IController, IRoute, ServerError, Request as sRequest } from '@spinajs/http';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ACL_CONTROLLER_DESCRIPTOR } from '../decorators.js';
import { IRbacDescriptor } from '../interfaces.js';
import { DI } from '@spinajs/di';
import { User } from '@spinajs/rbac';

/**
 * Checks if user is logged, authorized & have proper permissions
 */
export class RbacPolicy extends BasePolicy {
  protected Ac: AccessControl;

  constructor() {
    super();

    this.Ac = DI.get('AccessControl')!;
  }

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: sRequest, action: IRoute, instance: IController) {
    const descriptor: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);
    let permission = descriptor.Permission ?? [];

    if (descriptor.Routes.has(String(action.Method))) {
      // SECURITY: PermissionScope must NEVER be taken from a client-supplied
      // header. The ORM rbac query middleware uses PermissionScope to decide
      // which own/any grant to enforce and, on a scope it does not recognise or
      // that does not match the query type, it SKIPS row-level enforcement
      // entirely. Letting the client set it therefore allowed any authenticated
      // user holding only *Own grants to send `x-permission-scope: <anything>`
      // and read/update/delete every row (owner-field WHERE restriction never
      // applied). With no scope set, the middleware falls back to the correct
      // query-derived scope (QUERY_TO_PERMISSION), which is the secure default.
      //
      // If a route ever needs an explicit scope it must be derived server-side
      // from the route's declared permission, not from the request, e.g.:
      //   req.storage.PermissionScope = descriptor.Routes.get(String(action.Method))!.Permission?.[0];
      permission = descriptor.Routes.get(String(action.Method))!.Permission ?? [];
    }

    // check if route has its own permission
    if (!descriptor || !descriptor.Permission || descriptor.Permission.length === 0) {
      throw new ServerError(`no route permission or resources assigned`);
    }

    if (!req.storage || !req.storage.Session || !req.storage.User || !req.storage.Session.Data.get('Authorized')) {
      throw new AuthenticationFailed('user not logged or session expired');
    }

    if (!permission.some(p => checkRoutePermission(req, descriptor.Resource, p)?.granted)) {
      const effective = req.storage.ActiveRole ?? req.storage.User.Role;
      throw new Forbidden(`role(s) ${effective} does not have permission ${permission} for resource ${descriptor.Resource}`);
    }
  }
}

export function checkRbacPermission(role: string | string[], resource: string, permission: string): Permission {
  const ac = DI.get<AccessControl>('AccessControl')!;
  return (ac.can(role) as any)[permission](resource);
}

export function checkUserPermission(user: User, resource: string, permission: string): Permission | null {
  const ac = DI.get<AccessControl>('AccessControl')!;

  if (!user) {
    return null;
  }

  return (ac.can(user.Role) as any)[permission](resource);
}

export function checkRoutePermission(req: sRequest, resource: string, permission: string): Permission | null {
  if (!req.storage || !req.storage.User) {
    return null;
  }

  const ac = DI.get<AccessControl>('AccessControl')!;
  const roles = req.storage.ActiveRole ? [req.storage.ActiveRole] : req.storage.User.Role;
  return (ac.can(roles) as any)[permission](resource);
}
