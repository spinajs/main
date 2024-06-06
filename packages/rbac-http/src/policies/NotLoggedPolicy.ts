import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';

/**
 * Simple policy to only check if user is authorized ( do not check permissions for routes)
 * Usefull if we want to give acces for all logged users
 */
export class NotLoggedPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage || !req.storage.user || !req.storage.session?.Data.get('Authorized')) {
      return Promise.resolve();
    }

    throw new Forbidden('User already logged in, please logout first');

  }
}
