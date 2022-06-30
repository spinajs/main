import { AccessControl, Permission } from 'accesscontrol';
import { BasePolicy, IController, IRoute } from '@spinajs/http';
import * as express from 'express';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ACL_CONTROLLER_DESCRIPTOR } from './decorators';
import { IRbacDescriptor } from './interfaces';
import { DI } from '@spinajs/di';
import { User } from '@spinajs/rbac';

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

  public async execute(req: express.Request, action: IRoute, instance: IController) {
    const descriptor: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);
    let permission = descriptor.Permission ?? '';

    // check if route has its own permission
    if (descriptor.Routes.has(action.Method)) {
      permission = descriptor.Routes.get(action.Method).Permission ?? '';
    }

    if (!descriptor || !descriptor.Permission) {
      throw new Forbidden(`no route permission or resources assigned`);
    }

    if (!req.User) {
      throw new AuthenticationFailed();
    }

    if (!checkRoutePermission(req, descriptor.Resource, permission).granted) {
      throw new Forbidden(`role(s) ${req.User.Role} does not have permission ${permission} for resource ${descriptor.Resource}`);
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

  return (ac.can(user.Role.split(',')) as any)[permission](resource);
}

export function checkRoutePermission(req: express.Request, resource: string, permission: string): Permission {
  if (!req.User) {
    return null;
  }

  return checkUserPermission(req.User, resource, permission);
}
