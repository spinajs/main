import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
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
    if (!req.storage || !req.storage.user) {
      throw new Forbidden('user not logged or session expired');
    }

    const user = req.storage.user;
    if (user.IsGuest) {
      // if we disable guest account in config file, throw
      if (!user.IsActive) {
        throw new Forbidden('guest account is disabled');
      }
    }

    return Promise.resolve();
  }
}
