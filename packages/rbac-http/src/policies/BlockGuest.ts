import { BasePolicy, IController, IRoute, Request as sRequest, Unauthorized } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';

/**
 * Policy to block guests
 */
export class BlockGuest extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage || !req.storage.User) {
      throw new Unauthorized('user not logged or session expired');
    }

    if (req.storage.User.IsGuest) {
      throw new Forbidden('guest user is not allowed to access this resource');
    }

    return Promise.resolve();
  }
}
