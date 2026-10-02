import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';

/**
 * Simple policy to only check if user sends session
 * 
 * WARN: this is not check for user auth / not auth
 */
export class NoSessionPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage || !req.storage.User || !req.storage.Session) {
      return Promise.resolve();
    }

    throw new Forbidden('User already have session');

  }
}
