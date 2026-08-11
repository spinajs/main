import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
// Same side-effect import both siblings carry. `req.storage.Impersonator` comes
// from `@spinajs/rbac-http`'s augmentation of `IActionLocalStoregeContext`,
// which this package's `interfaces.ts` pulls into the program ( type-only ).
// Without it the field only type-checks when something ELSE in the compilation
// happened to drag that augmentation in - fine today, silently broken the day
// this file is compiled on its own.
import '../interfaces.js';

/**
 * Rejects requests made from an impersonated session.
 *
 * Impersonation is a *supervised, revocable* act: an administrator borrows a
 * user's view of the application and the borrowing ends when the impersonation
 * does. An access token is the opposite - a bearer credential that outlives the
 * session that minted it, carries the victim's roles, and is invisible in the
 * impersonator's own audit trail. Letting a credential-issuing route run while
 * impersonating therefore turns a temporary, reversible grant into a permanent
 * one that the account owner never consented to and cannot see.
 *
 * `RbacMiddleware` puts the impersonation TARGET in `req.storage.User` and the
 * original administrator in `req.storage.Impersonator`
 * ( `rbac-http/src/middlewares.ts` ), so every ownership and permission check
 * downstream already reads as the victim - this policy is the only thing that
 * can tell the two situations apart.
 *
 * Same reasoning as a password change demanding the CURRENT password: an
 * operation that hands out lasting credentials has to be performed by the
 * account owner, not on their behalf.
 */
export class NoImpersonationPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest, _action: IRoute, _instance: IController): Promise<void> {
    if (req.storage?.Impersonator) {
      throw new Forbidden('this route cannot be used while impersonating another user');
    }
  }
}
