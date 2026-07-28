import { Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { SessionProvider, User, UserImpersonationEnded } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { _ev } from '@spinajs/queue';

/** Session keys holding the impersonation block. */
export const IMPERSONATION_KEYS = {
  IMPERSONATOR: 'Impersonator',
  STARTED_AT: 'ImpersonationStartedAt',
  ORIGINAL_ACTIVE_ROLE: 'OriginalActiveRole',
} as const;

/** Outcome of an attempt to end an impersonation. */
export type RevertResult =
  /** Impersonation ended; the original user is back in the session. */
  | { Status: 'reverted'; Original: User; ActiveRole: string | undefined }
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
   */
  public async start(session: ISession, impersonator: User, target: User, startedAt: string): Promise<string | undefined> {
    const previousActiveRole = session.Data.get('ActiveRole') as string | undefined;

    session.Data.set(IMPERSONATION_KEYS.IMPERSONATOR, impersonator.Uuid);
    session.Data.set('User', target.Uuid);
    session.Data.set(IMPERSONATION_KEYS.STARTED_AT, startedAt);

    if (previousActiveRole !== undefined) {
      session.Data.set(IMPERSONATION_KEYS.ORIGINAL_ACTIVE_ROLE, previousActiveRole);
    }

    const targetActiveRole = target.Role?.[0];
    if (targetActiveRole) {
      session.Data.set('ActiveRole', targetActiveRole);
    }

    await this.SessionProvider.save(session);
    return targetActiveRole;
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

    await this.clearBlock(session);
    await this.emitEnded(original, target);

    return { Status: 'reverted', Original: original, ActiveRole: restoredActiveRole };
  }

  /** Drops the impersonation keys and persists the session. */
  protected async clearBlock(session: ISession): Promise<void> {
    session.Data.delete(IMPERSONATION_KEYS.IMPERSONATOR);
    session.Data.delete(IMPERSONATION_KEYS.STARTED_AT);
    session.Data.delete(IMPERSONATION_KEYS.ORIGINAL_ACTIVE_ROLE);
    await this.SessionProvider.save(session);
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
