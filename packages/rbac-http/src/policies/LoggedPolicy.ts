import { BasePolicy, IController, IRoute, Request as sRequest, Unauthorized } from '@spinajs/http';

/**
 * Simple policy to only check if user is authorized ( do not check permissions for routes)
 * Usefull if we want to give acces for all logged users
 */
export class LoggedPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    // acl is always on if set
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage || !req.storage.User || !req.storage.Session?.Data.get('Authorized')) {
      throw new Unauthorized('user not logged or session expired');
    }

    return Promise.resolve();
  }
}
