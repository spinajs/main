import { BasePolicy, IController, IRoute } from '@spinajs/http';
import { IAclDescriptor } from './interfaces';
import { ACL_CONTROLLER_DESCRIPTOR } from './decorators';
import * as express from 'express';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';

export class AclPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: express.Request, action: IRoute, instance: IController) {
    if (!req.User) {
      throw new AuthenticationFailed();
    }

    const descriptor: IAclDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);
    let permission = descriptor.Permission ?? '*';

    // check if route has its own permission
    if (descriptor.Routes.has(action.Method)) {
      permission = descriptor.Routes.get(action.Method).Permission;
    }

    if (!req.User.isAllowed(descriptor.Resource, permission)) {
      throw new Forbidden();
    }
  }
}
