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

export type AuthnEventType = 'login' | 'logout' | 'mfa.challenge' | 'mfa.verify' | 'mfa.enrol' | 'mfa.disable' | 'reauth' | 'session.issue' | 'session.rotate' | 'session.revoke' | 'session.expire' | 'password.change' | 'password.reset.request' | 'password.reset' | 'invite.redeem' | 'token.create' | 'token.use' | 'token.revoke' | 'token.rotate' | 'token.update' | 'key.register' | 'key.use' | 'key.revoke' | 'identity.link' | 'identity.unlink' | 'impersonation.start' | 'impersonation.end' | 'impersonation.expire' | 'throttle.block' | 'passkey.register' | 'passkey.remove' | 'address.verify.request' | 'address.verify' | 'code.request' | 'identity.register' | 'role.switch' | 'request.refuse';

/**
 * Reacts to authentication events in the process that raised them: every registered listener gets every event (A21).
 * AuthnAudit calls the listeners concurrently, each bounded by `authn.audit.listenerTimeoutMs`; a listener that throws
 * or runs out of time is logged and never fails the publish. Recording is a listener too: `@spinajs/audit-authn`.
 */
export abstract class AuthnEventListener {
  abstract on(e: AuthnEvent): Promise<void>;

  /** Awaited once when AuthnAudit resolves; a throw fails the boot. For a setting that must be right before the first event. */
  ready?(): void | Promise<void>;

  /** Awaited by `AuthnAudit.settled()`: writes out what `on` buffered. */
  flush?(): Promise<void>;
}

/**
 * @deprecated Extend AuthnEventListener and rename `publish` to `on`. Kept only while the packages of this repository
 * move over; it is removed before 4.0 is released.
 */
export abstract class AuthnEventSink extends AuthnEventListener {
  abstract publish(e: AuthnEvent): Promise<void>;

  public on(e: AuthnEvent): Promise<void> {
    return this.publish(e);
  }
}
