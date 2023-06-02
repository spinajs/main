import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
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
    if (!req.storage || !req.storage.user) {
      throw new Forbidden('user not logged or session expired');
    }

    if (req.storage.user) {
      throw new Forbidden('user not logged or session expired');
    }

    return Promise.resolve();
  }
}
