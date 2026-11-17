import { CodedHttpException } from '@spinajs/exceptions';

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
 * AuthnAudit calls the listeners concurrently, each bounded by `authn.audit.listenerTimeoutMs`. A listener that throws
 * or runs out of time is logged and does not fail the publish, unless it is blocking. Recording is a listener too:
 * `@spinajs/audit-authn`.
 */
export abstract class AuthnEventListener {
  abstract on(e: AuthnEvent): Promise<void>;

  /**
   * True for a listener an operation must not go on without. AuthnAudit asks on every event and hands a success event
   * to the blocking listeners first: when one fails or runs out of time, `publish` and `publishIn` reject with
   * AuthnListenerFailed and no other listener is told. Failure events and detached events are never stopped.
   */
  public get blocking(): boolean {
    return false;
  }

  /** Awaited once when AuthnAudit resolves; a throw fails the boot. For a setting that must be right before the first event. */
  ready?(): void | Promise<void>;

  /** Awaited by `AuthnAudit.settled()`: writes out what `on` buffered. */
  flush?(): Promise<void>;
}

/**
 * A blocking listener did not take a success event, so the operation that raised it stops. `@spinajs/http` answers it
 * 503 with the code `authn_listener_failed`: the caller is not at fault and may try again. Not an InvalidOperation,
 * which the session routes of authn-http read as an ended session. The message is the problem document's `detail`, so it
 * names neither the listener nor the event: those are fields for the log.
 */
export class AuthnListenerFailed extends CodedHttpException<'authn_listener_failed'> {
  constructor(
    public readonly listener: string,
    public readonly eventType: string,
    inner: unknown,
  ) {
    super(503, 'authn_listener_failed', 'an authentication event could not be recorded; try again later', undefined, inner);
  }
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
