import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
// Brings the `req.storage.TokenAuth` module augmentation into the program.
import '../interfaces.js';

/**
 * Rejects requests authenticated with an access token. Applied to the token
 * management API so a token can never be used to mint or manage tokens
 * ( no self-replication ). Session-authenticated requests pass through.
 */
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
