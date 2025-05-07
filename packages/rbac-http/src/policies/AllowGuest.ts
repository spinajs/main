import { BasePolicy, IController, IRoute, Request as sRequest, Unauthorized } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';

/**
 * Policy to block guests
 */
export class AllowGuest extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage || !req.storage.User) {
      throw new Unauthorized('user not logged or session expired');
    }

    const user = req.storage.User;
    if (user.IsGuest) {
      // if we disable guest account in config file, throw
      if (!user.IsActive) {
        throw new Forbidden('guest account is disabled');
      }
    }

    return Promise.resolve();
  }
}
