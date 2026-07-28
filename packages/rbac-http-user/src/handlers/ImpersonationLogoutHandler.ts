import { Autoinject, Injectable } from '@spinajs/di';
import { LogoutHandler, ILogoutContext, ILogoutResult } from '../logout.js';
import { ImpersonationService } from '../services/ImpersonationService.js';

/**
 * Logout handler that detects an active impersonation and reverts it instead
 * of destroying the session. Runs early (priority 10) so it short-circuits
 * the default session-deletion handler when applicable.
 */
@Injectable(LogoutHandler)
export class ImpersonationLogoutHandler extends LogoutHandler {
  public Priority = 10;

  @Autoinject(ImpersonationService)
  protected Impersonation: ImpersonationService;

  public async handle(context: ILogoutContext): Promise<ILogoutResult | null> {
    if (!this.Impersonation.isActive(context.Session)) {
      return null;
    }

    const result = await this.Impersonation.revert(context.Session, context.User);

    switch (result.Status) {
      case 'reverted':
        // Take ownership of the response: no cookie change — the original
        // user's session continues.
        return { Body: { ImpersonationEnded: true } };

      case 'impersonator-gone':
        // The impersonator's account disappeared mid-impersonation. The stale
        // block has been cleared, but there is no identity left to hand the
        // session back to — defer to the default handler so the session is
        // destroyed and the caller is logged out properly. Reverting used to
        // dereference the missing user here and answer a logout with a 500.
        return null;

      default:
        return null;
    }
  }
}
