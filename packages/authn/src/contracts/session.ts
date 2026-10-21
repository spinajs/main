import type { IdentityRef } from './credentials.js';
import type { AuthnFacts } from './principal.js';
import type { Session } from './session-state.js';

export interface SessionHandle {
  /** Raw id; lives only in memory and the cookie. */
  readonly id: string;
  readonly state: 'pending' | 'active';
}

/** What `SessionIssuer.reissue` may change in the facts of an active session; it never lowers the assurance. */
export interface SessionFactsChange {
  readonly assurance?: 'aal2';
  readonly mfa?: readonly string[];
  readonly authenticatedAt?: Date;
}

/** Implemented by @spinajs/authn-session. */
export abstract class SessionIssuer {
  /**
   * With `pending`: a pre-MFA session that yields no principal and expires after authn.session.pendingTtlSeconds (A09).
   * Impersonation start and end each issue a NEW session (start: for the target, with facts.impersonator, stored as its
   * Impersonator; end: for the impersonator) and revoke the old one, so the id rotates and `set` never switches identities.
   */
  abstract issue(identity: IdentityRef, facts: AuthnFacts, opts?: { pending?: { steps: readonly string[] } }): Promise<SessionHandle>;
  /**
   * Looks the session up by sha256(rawId) (A07), so a stored hash never works as an id (SR-18).
   */
  abstract restore(rawId: string): Promise<Session | null>;
  /** New id, same data (fixation). */
  abstract rotate(h: SessionHandle): Promise<SessionHandle>;
  /** pending → active, aal2; rotates. Refuses an active session, whose facts only `reissue` changes. */
  abstract elevate(h: SessionHandle, facts: Partial<AuthnFacts>): Promise<SessionHandle>;
  /**
   * Active sessions only: moves the row to a fresh id with `change` merged into its facts; data, subject, impersonator,
   * creation and expiry are kept. Refuses a pending session. As with `rotate`, a revocation that lands during the move
   * stays in force, and of parallel reissues of one session exactly one succeeds.
   */
  abstract reissue(h: SessionHandle, change: SessionFactsChange): Promise<SessionHandle>;
  /** Holds ActiveRole and the impersonation block. Never changes the subject, impersonator or state: the issuer refuses its reserved keys. */
  abstract set(h: SessionHandle, key: string, value: unknown): Promise<void>;
  /** True only for the call that ended the session, so of parallel revokes of one session exactly one gets true. */
  abstract revoke(h: SessionHandle): Promise<boolean>;
  /** Returns the count. includeImpersonations also ends sessions in which the subject is the impersonator (SR-06, A08, A20). */
  abstract revokeAll(subject: IdentityRef, opts?: { except?: SessionHandle; includeImpersonations?: boolean }): Promise<number>;
  /**
   * Serves DELETE /user/sessions/:handle (§22.11). Owner-bound: ends only a session whose subject is `subject` (not one it
   * impersonates from) and whose listed handle equals `handle`; false otherwise (no IDOR). `handle` is the hashed handle of `list`.
   */
  abstract revokeHandle(subject: IdentityRef, handle: string): Promise<boolean>;
  /**
   * `current` marks the row of that handle.
   * Includes sessions in which someone impersonates `subject`: they act as it, so it may see and revoke them,
   * and it sees the impersonator's ip and userAgent.
   * Each `handle` is a one-way value derived from the storage key with domain separation, never the storage key or the raw id;
   * it equals AuthnFacts.sessionHandle and AuthnEvent.session.
   */
  abstract list(subject: IdentityRef, opts?: { current?: SessionHandle }): Promise<readonly { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean }[]>;
  /** Ends every session issued from `provider` with IdP session id `sid` (AuthnFacts.external); returns the count. */
  abstract revokeByExternal(provider: string, sid: string): Promise<number>;
  /** Optional; the authn service calls it at boot with its configuration, so an issuer that cannot run on it fails the boot. */
  checkConfiguration?(booting: { get<T>(path: string | string[]): T }): Promise<void>;
}
