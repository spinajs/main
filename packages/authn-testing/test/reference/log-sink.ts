import { createHmac } from 'node:crypto';
import { AuthnEventSink, AuthnService } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthenticationStrategy, AuthnContext, AuthnEvent, Credentials, Principal, SessionHandle } from '@spinajs/authn/contracts';
import type { LogsPort } from '../../src/harness/index.js';

/**
 * A log sink in the shape of LogAuthnAuditSink: login strings are written as keyed hashes (SR-19).
 * Events carry no login string, so `hint` holds the login of the attempt in flight (see withLoginHints).
 */
export class ReferenceLogSink extends AuthnEventSink implements LogsPort {
  private readonly out: string[] = [];
  /** The login of the attempt in flight, if any. */
  hint: string | null = null;

  /** `rawLogins` is the mutant of the SR-19 check: it writes the login string as it is. */
  constructor(private readonly opts: { rawLogins?: boolean } = {}) {
    super();
  }

  async publish(e: AuthnEvent): Promise<void> {
    const login = e.type === 'login' && e.outcome === 'failure' && this.hint !== null ? (this.opts.rawLogins ? this.hint : createHmac('sha256', 'kit-key').update(this.hint).digest('hex')) : undefined;
    this.out.push([e.at.toISOString(), e.type, e.outcome, e.reason && `reason=${e.reason}`, e.identity && `identity=${e.identity.id}`, login && `login=${login}`].filter(Boolean).join(' '));
  }

  lines(): readonly string[] {
    return [...this.out];
  }
}

/** Passes every call on and tells the sink which login a password attempt carries. */
class LoginHintingService extends AuthnService {
  constructor(private readonly inner: AuthnService, private readonly sink: ReferenceLogSink) {
    super();
  }

  async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    this.sink.hint = c.kind === 'password' ? String(c.login) : null;
    try {
      return await this.inner.authenticate(c, ctx);
    } finally {
      this.sink.hint = null;
    }
  }

  completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    return this.inner.completeMfa(pending, step, response, ctx);
  }

  reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean> {
    return this.inner.reauthenticate(session, c, ctx);
  }

  principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal> {
    return this.inner.principalOf(result);
  }

  strategies(): readonly AuthenticationStrategy[] {
    return this.inner.strategies();
  }
}

export const withLoginHints = (service: AuthnService, sink: ReferenceLogSink): AuthnService => new LoginHintingService(service, sink);
