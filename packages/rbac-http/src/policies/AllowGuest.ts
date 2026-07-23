import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';

/**
 * Policy that ALLOWS guest users through. Access is only refused when the
 * request has no user/session at all, or when the guest account itself has
 * been globally disabled (IsActive === false). Use BlockGuest for the opposite
 * behavior (reject guests, require a real logged-in user).
 */
export class AllowGuest extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage || !req.storage.User) {
      throw new AuthenticationFailed('user not logged or session expired');
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
