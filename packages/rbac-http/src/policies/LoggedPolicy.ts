import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';

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
    if (!req.storage || !req.storage.user || !req.storage.session?.Data.get('Authorized')) {
      throw new Forbidden('user not logged or session expired');
    }

    return Promise.resolve();
  }
}
