import { AccessControl } from '@spinajs/rbac';
import { BasePolicy, IController, IRoute } from '@spinajs/http';
import * as express from 'express';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ACL_CONTROLLER_DESCRIPTOR } from './decorators';
import { IAclDescriptor } from './interfaces';
import { Autoinject, DI, Inject } from '@spinajs/di';

export class AclPolicy extends BasePolicy {
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
    const descriptor: IAclDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);
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

    if (!(this.Ac.can(req.User.Role.split(',')).resource(descriptor.Resource) as any)[permission]()) {
      throw new Forbidden(`role(s) ${req.User.Role} does not have permission ${permission} for resource ${descriptor.Resource}`);
    }
  }
}
