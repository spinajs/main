import { Autoinject, DI, Injectable } from '@spinajs/di';
import type { PrincipalRef } from '@spinajs/authz';
import { AuthnEventSink, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnEventType } from '@spinajs/authn/contracts';
import { SseAccessPushTransport } from '../client-access/sse.js';

const SESSION_ENDS: ReadonlySet<AuthnEventType> = new Set<AuthnEventType>(['logout', 'session.revoke', 'session.expire']);

/**
 * Their `session` is not always the ended one (stop names the impersonator's new session, start the
 * impersonation's), so the identity's and the actor's streams are only re-checked against the SessionIssuer.
 */
const IMPERSONATION: ReadonlySet<AuthnEventType> = new Set<AuthnEventType>(['impersonation.start', 'impersonation.end', 'impersonation.expire']);

/** Ends a session's event streams when authn reports the session's end (logout, revoke, impersonation start and end). */
@Injectable(AuthnEventSink)
export class SseSessionEndSink extends AuthnEventSink {
  @Autoinject(SseAccessPushTransport)
  protected Transport: SseAccessPushTransport;

  public async publish(e: AuthnEvent): Promise<void> {
    const ends = SESSION_ENDS.has(e.type);
    if (e.outcome !== 'success' || !e.identity || (!ends && !IMPERSONATION.has(e.type))) return;
    if (ends) await this.sessionEnded(e.identity, e.session);
    else await Promise.all([e.identity, ...(e.actor ? [e.actor] : [])].map((who) => this.sessionEnded(who)));
  }

  /**
   * Ends the session streams of `identity` that `session` names or the SessionIssuer no longer lists. The re-check also
   * catches a stream whose handle went stale while it was open: a rotation or role switch re-keys the session row and
   * publishes no event, so the logout names a handle the stream never saw.
   */
  protected async sessionEnded(identity: PrincipalRef, session?: string): Promise<void> {
    const transport = this.Transport;
    if (session !== undefined) transport.endSession(identity, session);
    // Per call: authz boot builds the transport, sse in use or not, and must not build the issuer's session provider then.
    if (transport.sessionHandles(identity).length === 0) return;
    const issuer = await DI.RootContainer.resolveOptional<SessionIssuer>(SessionIssuer);
    if (!issuer) return;
    const live = new Set((await issuer.list({ type: identity.type, id: identity.id })).map((r) => r.handle));
    transport.endSessionsExcept(identity, live);
  }
}
