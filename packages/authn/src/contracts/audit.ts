import type { IdentityRef } from './credentials.js';
import type { PrincipalRef } from './principal.js';

export interface AuthnEvent {
  readonly type: AuthnEventType;
  readonly at: Date;
  readonly outcome: 'success' | 'failure';
  readonly identity?: IdentityRef;
  readonly actor?: PrincipalRef;
  readonly strategy?: string;
  /** The real failure reason; audit only, HTTP answers one shape (A02). */
  readonly reason?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Hashed session handle (AuthnFacts.sessionHandle), never the raw id. */
  readonly session?: string;
  /** Never passwords, tokens, secrets or raw session ids (A21). */
  readonly data?: Readonly<Record<string, unknown>>;
}

export type AuthnEventType = 'login' | 'logout' | 'mfa.challenge' | 'mfa.verify' | 'mfa.enrol' | 'mfa.disable' | 'reauth' | 'session.issue' | 'session.rotate' | 'session.revoke' | 'session.expire' | 'password.change' | 'password.reset.request' | 'password.reset' | 'invite.redeem' | 'token.create' | 'token.use' | 'token.revoke' | 'key.register' | 'key.use' | 'key.revoke' | 'identity.link' | 'identity.unlink' | 'impersonation.start' | 'impersonation.end' | 'impersonation.expire' | 'throttle.block';

/**
 * Registered with Array.ofType: every sink gets every event (A21).
 * Log sinks write identifiers (login strings, emails) as keyed hashes (authn.audit.hashIdentifiers, SR-19);
 * the audit stream keeps the identity id.
 */
export abstract class AuthnEventSink {
  abstract publish(e: AuthnEvent): Promise<void>;
}
