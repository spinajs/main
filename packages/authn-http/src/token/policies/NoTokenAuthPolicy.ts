import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { NewInstance } from '@spinajs/di';
// Brings the `req.storage.TokenAuth` module augmentation into the program.
import '@spinajs/authn-token';

/**
 * Rejects requests authenticated with an access token. Applied to the token
 * management API so a token can never be used to mint or manage tokens
 * ( no self-replication ). Session-authenticated requests pass through.
 */
// The 3.0 policy has this class name too and DI keys classes by name: a singleton would hand one class's instance
// out for the other.
@NewInstance()
export class NoTokenAuthPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest, _action: IRoute, _instance: IController): Promise<void> {
    if (req.storage?.TokenAuth) {
      throw new Forbidden('access tokens cannot be used on this route');
    }
  }
}
