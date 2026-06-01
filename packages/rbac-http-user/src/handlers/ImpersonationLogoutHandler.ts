import { Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { SessionProvider, User, UserImpersonationEnded } from '@spinajs/rbac';
import { _ev } from '@spinajs/queue';
import { LogoutHandler, ILogoutContext, ILogoutResult } from '../logout.js';

/**
 * Logout handler that detects an active impersonation and reverts it instead
 * of destroying the session. Runs early (priority 10) so it short-circuits
 * the default session-deletion handler when applicable.
 */
@Injectable(LogoutHandler)
export class ImpersonationLogoutHandler extends LogoutHandler {
  public Priority = 10;

  @AutoinjectService('rbac.session')
  protected SessionProvider!: SessionProvider;

  public async handle(context: ILogoutContext): Promise<ILogoutResult | null> {
    const session = context.Session;
    if (!session) return null;

    const impersonatorUuid = session.Data.get('Impersonator') as string | undefined;
    if (!impersonatorUuid) return null;

    const original = await User.getByUuid(impersonatorUuid);

    session.Data.set('User', original.Uuid);
    session.Data.delete('Impersonator');
    session.Data.delete('ImpersonationStartedAt');
    const restoredActiveRole = (session.Data.get('OriginalActiveRole') as string | undefined) ?? original.Role?.[0];
    if (restoredActiveRole) {
      session.Data.set('ActiveRole', restoredActiveRole);
    }
    session.Data.delete('OriginalActiveRole');

    await this.SessionProvider.save(session);
    await this.emitEvent(original, context.User);

    // Take ownership of the response: no cookie change — the original user's
    // session continues.
    return { Body: { ImpersonationEnded: true } };
  }

  /**
   * Hook for tests to intercept event emission without stubbing the module-level
   * `_ev` ESM binding.
   */
  protected emitEvent(original: User, target: User): Promise<void> {
    return _ev(new UserImpersonationEnded(original, target))();
  }
}
