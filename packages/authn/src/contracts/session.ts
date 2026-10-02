import type { IdentityRef } from './credentials.js';
import type { AuthnFacts } from './principal.js';

export interface SessionHandle {
  /** Raw id; lives only in memory and the cookie. */
  readonly id: string;
  readonly state: 'pending' | 'active';
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
   * Looks the session up by sha256(rawId); only a uuid v4 input falls back to a raw lookup, so a 2.x id is migrated
   * on first use (A07) and a stored hash never works as an id (SR-18).
   */
  abstract restore(rawId: string): Promise<{ handle: SessionHandle; identity: IdentityRef; facts: AuthnFacts; data: ReadonlyMap<string, unknown> } | null>;
  /** New id, same data (fixation). */
  abstract rotate(h: SessionHandle): Promise<SessionHandle>;
  /** pending → active, aal2; rotates. */
  abstract elevate(h: SessionHandle, facts: Partial<AuthnFacts>): Promise<SessionHandle>;
  /** Holds ActiveRole and the impersonation block. Never changes the subject, impersonator or state: the issuer refuses its reserved keys. */
  abstract set(h: SessionHandle, key: string, value: unknown): Promise<void>;
  abstract revoke(h: SessionHandle): Promise<void>;
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
}
