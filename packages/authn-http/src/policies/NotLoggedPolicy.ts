import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { NewInstance } from '@spinajs/di';

/**
 * Simple policy to only check if user is authorized ( do not check permissions for routes)
 * Usefull if we want to give acces for all logged users
 */
// The 3.0 policy has this class name too and DI keys classes by name: a singleton would hand one class's instance
// out for the other.
@NewInstance()
export class NotLoggedPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest) {
    if (!req.storage.Session?.Data.get('Logged')) {
      return Promise.resolve();
    }

    throw new Forbidden('User already logged in, please logout first');

  }
}
