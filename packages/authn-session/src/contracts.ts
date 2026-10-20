import { AsyncService } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { DateTime } from 'luxon';

export interface ISession {
  /** Storage key: sha256(raw id) as hex. Raw ids never reach a store. */
  SessionId: string;

  /** Owner; while impersonating, the target. Indexed. */
  Subject: IdentityRef;

  /** Set while impersonating. Indexed, so revoking the impersonator reaches the session (SR-06). */
  Impersonator?: IdentityRef;

  /**
   * A pending (pre-MFA) session yields no principal; SessionIssuer sets its
   * Expiration to issue + authn.session.pendingTtlSeconds and stores never extend it (A09).
   */
  State: SessionHandle['state'];

  Creation: DateTime;

  /** Absolute expiration instant. `undefined` = never expires. */
  Expiration?: DateTime;

  /** Opaque to the store: SessionIssuer.set values plus the issuer's own entries (facts, pending steps). */
  Data: Map<string, unknown>;
}

/**
 * Session expiration strategy, resolved by service name at
 * `authn.session.expiration.service`. Units for all shipped strategies are MINUTES.
 */
export abstract class SessionExpirationProvider {
  /** `undefined` = never expires. */
  public abstract initial(session: ISession): DateTime | undefined;

  public abstract renew(session: ISession): DateTime | undefined;
}

/** Storage only: SessionIssuer hashes ids; a store keys rows by whatever SessionId it gets. */
export abstract class SessionProvider<T extends ISession = ISession> extends AsyncService {
  /** Shared by every store so expiration means the same everywhere. */
  @AutoinjectService('authn.session.expiration', SessionExpirationProvider)
  protected Expiration!: SessionExpirationProvider;

  /** Takes a storage key. Missing or expired ⇒ null: an expired row is absent. */
  public abstract restore(sessionId: string): Promise<T | null>;

  /** Upsert. Persists `Expiration` verbatim; only a session without one gets the initial expiration. */
  public abstract save(session: ISession): Promise<void>;

  /** Renews through applyRenewedExpiration, so a pending session is never extended; true when the expiration changed and was written. */
  public abstract touch(session: ISession): Promise<boolean>;

  /** True only when this call removed the row: one atomic store operation, so parallel deletes of one key yield one true. */
  public abstract delete(sessionId: string): Promise<boolean>;

  /**
   * Deletes the subject's sessions and returns how many. With includeImpersonations
   * also the sessions whose impersonator is the subject (SR-06). `except` is a
   * storage key.
   */
  public abstract deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number>;

  /** Live sessions only: expired rows are left out. Same matching as deleteBySubject. */
  public abstract listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<T[]>;

  public abstract truncate(): Promise<void>;

  protected applyInitialExpiration(s: ISession): void {
    if (s.State === 'pending') {
      throw new Error('A pending session must carry its own expiration (authn.session.pendingTtlSeconds)');
    }
    s.Expiration = this.Expiration.initial(s);
  }

  protected applyRenewedExpiration(s: ISession): void {
    if (s.State === 'pending') {
      return;
    }
    s.Expiration = this.Expiration.renew(s);
  }

  protected isExpired(s: ISession): boolean {
    return !!s.Expiration && s.Expiration <= DateTime.now();
  }
}
