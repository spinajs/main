import { Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { SessionProvider, User, UserImpersonationEnded, regenerateSession } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { _ev } from '@spinajs/queue';

/** Session keys holding the impersonation block. */
export const IMPERSONATION_KEYS = {
  IMPERSONATOR: 'Impersonator',
  STARTED_AT: 'ImpersonationStartedAt',
  ORIGINAL_ACTIVE_ROLE: 'OriginalActiveRole',

  /**
   * Numeric id of the impersonator, stashed because `session.UserId` is handed
   * over to the target for the duration — see {@link ImpersonationService.start}.
   */
  ORIGINAL_USER_ID: 'OriginalUserId',
} as const;

/** Outcome of an attempt to end an impersonation. */
export type RevertResult =
  /** Impersonation ended; the original user is back in the session. */
  | { Status: 'reverted'; Original: User; ActiveRole: string | undefined; Session: ISession }
  /** The session carried no impersonation — nothing was changed. */
  | { Status: 'not-impersonating' }
  /** The impersonator no longer exists; the stale block was cleared. */
  | { Status: 'impersonator-gone' };

/**
 * Owns the impersonation session block.
 *
 * The revert path is reachable two ways — explicitly via `DELETE /auth/impersonate`
 * and implicitly when an impersonating user logs out — and both used to carry
 * their own copy of the key juggling. The copies had already drifted: the logout
 * handler dereferenced a deleted impersonator without a guard and answered a
 * logout with a 500, while the controller handled that same case.
 */
@Injectable()
export class ImpersonationService {
  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  /** True when the session is currently acting as somebody else. */
  public isActive(session: ISession | null | undefined): boolean {
    return Boolean(session?.Data.get(IMPERSONATION_KEYS.IMPERSONATOR));
  }

  /**
   * Begin acting as `target`. The impersonator's own ActiveRole is stashed so
   * `revert` can restore it, and the effective ActiveRole becomes the target's
   * first role.
   *
   * Two things beyond the key juggling:
   *
   *  - the session id is REGENERATED. Assuming another identity is a privilege
   *    change, and a privilege change on a session id that an attacker may
   *    already know is the definition of session fixation.
   *  - `session.UserId` is handed over to the target and the impersonator's own
   *    id is stashed. Ownership is what `deleteByUser` keys on, so while the
   *    impersonation runs, "log this user out everywhere" aimed at the target
   *    reaches the impersonating session too — which is exactly what an
   *    administrator killing a compromised account expects.
   *
   * @returns the regenerated session and the ActiveRole now in effect
   */
  public async start(session: ISession, impersonator: User, target: User, startedAt: string): Promise<{ Session: ISession; ActiveRole: string | undefined }> {
    const previousActiveRole = session.Data.get('ActiveRole') as string | undefined;

    session.Data.set(IMPERSONATION_KEYS.IMPERSONATOR, impersonator.Uuid);
    session.Data.set(IMPERSONATION_KEYS.ORIGINAL_USER_ID, session.UserId ?? impersonator.Id);
    session.Data.set('User', target.Uuid);
    session.Data.set(IMPERSONATION_KEYS.STARTED_AT, startedAt);

    if (previousActiveRole !== undefined) {
      session.Data.set(IMPERSONATION_KEYS.ORIGINAL_ACTIVE_ROLE, previousActiveRole);
    }

    const targetActiveRole = target.Role?.[0];
    if (targetActiveRole) {
      session.Data.set('ActiveRole', targetActiveRole);
    }

    session.UserId = target.Id;

    const regenerated = await regenerateSession(this.SessionProvider, session);

    return { Session: regenerated, ActiveRole: targetActiveRole };
  }

  /**
   * End an active impersonation and put the original user back in the session.
   *
   * The session survives either way — reverting is not a logout. When the
   * original user is gone the impersonation block is still cleared, so the
   * session stops claiming an identity that cannot be resolved, and the caller
   * is told to re-authenticate rather than being handed a 500.
   */
  public async revert(session: ISession | null | undefined, target: User): Promise<RevertResult> {
    if (!session) {
      return { Status: 'not-impersonating' };
    }

    const impersonatorUuid = session.Data.get(IMPERSONATION_KEYS.IMPERSONATOR) as string | undefined;
    if (!impersonatorUuid) {
      return { Status: 'not-impersonating' };
    }

    const original = await this.loadOriginal(impersonatorUuid);

    if (!original) {
      await this.clearBlock(session);
      return { Status: 'impersonator-gone' };
    }

    session.Data.set('User', original.Uuid);

    const restoredActiveRole =
      (session.Data.get(IMPERSONATION_KEYS.ORIGINAL_ACTIVE_ROLE) as string | undefined) ?? original.Role?.[0];
    if (restoredActiveRole) {
      session.Data.set('ActiveRole', restoredActiveRole);
    }

    // ownership goes back to the impersonator along with the identity
    session.UserId = (session.Data.get(IMPERSONATION_KEYS.ORIGINAL_USER_ID) as number | undefined) ?? original.Id;

    this.dropBlockKeys(session);

    // Dropping an identity is a privilege change too — the id the target's
    // session was reachable under does not survive into the impersonator's.
    const regenerated = await regenerateSession(this.SessionProvider, session);

    await this.emitEnded(original, target);

    return { Status: 'reverted', Original: original, ActiveRole: restoredActiveRole, Session: regenerated };
  }

  /** Drops the impersonation keys and persists the session under the same id. */
  protected async clearBlock(session: ISession): Promise<void> {
    this.dropBlockKeys(session);
    await this.SessionProvider.save(session);
  }

  /** Removes the impersonation keys from session data without persisting. */
  protected dropBlockKeys(session: ISession): void {
    session.Data.delete(IMPERSONATION_KEYS.IMPERSONATOR);
    session.Data.delete(IMPERSONATION_KEYS.STARTED_AT);
    session.Data.delete(IMPERSONATION_KEYS.ORIGINAL_ACTIVE_ROLE);
    session.Data.delete(IMPERSONATION_KEYS.ORIGINAL_USER_ID);
  }

  /**
   * Load the original (impersonator) user, or undefined when the account is
   * gone. Extracted so tests can stub it without a database.
   */
  protected async loadOriginal(uuid: string): Promise<User | undefined> {
    return (await User.getByUuid(uuid)) as User | undefined;
  }

  /**
   * Hook for tests to intercept event emission without stubbing the
   * module-level `_ev` ESM binding.
   */
  protected emitEnded(original: User, target: User): Promise<void> {
    return _ev(new UserImpersonationEnded(original, target))();
  }
}
