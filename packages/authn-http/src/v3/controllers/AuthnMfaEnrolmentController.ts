import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { TotpServiceRegistered, codeField, reauthOf, totpRefusal, totpServiceOf } from '../../mfa/index.js';
import { refused, unauthenticated } from '../../policies/v3/errors.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, PendingMfaEnrolment } from '../index.js';
import { NO_STORE, authnFailureResponse } from '../responses.js';
import { contextOf } from '../routes.js';
import type { Restored } from '../routes.js';

/**
 * The owner's TOTP enrolment over authn-totp's TotpService (design §22.8, §22.11; A09, A10, A13). Off (404) while no
 * TotpService is registered. Every route acts on the identity of the caller's own session: a token or key caller gets
 * 403 `session_required`, an impersonation 403 `impersonating` (a factor enrolled there would lock the owner out).
 * Begin and confirm also take a pending session that the MFA policy forces to enrol, while its identity is enrolled in
 * no step; every other route needs a full login.
 *
 * Begin, disable and recovery-codes need fresh auth: a login within authn.freshAuth.maxAgeSeconds or the account
 * password in `reauthPassword`, which TotpService verifies for that request only. A stale session without it gets 403
 * `fresh_auth_required`; a wrong password, a wrong code, or a missing or over-long one the login failure body (A02),
 * with Retry-After only when the mfa throttle refused the code. Enrolment state conflicts answer 409 `mfa_enrolled`,
 * `mfa_not_begun` or `mfa_not_enrolled`. No route rotates the session id (A07 lists none of them).
 * @tags Authentication
 */
@BasePath('user')
@Policy(TotpServiceRegistered)
export class AuthnMfaEnrolmentController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * MFA status
   * `{ steps: [{ name, enrolled }] }` for each step of authn.mfa.steps; a begun but unconfirmed enrolment is not
   * enrolled. Never a secret.
   * @security cookieAuth
   */
  @Get('mfa')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async status(@Req() req: Request) {
    const session = activeSession(req);
    // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
    const { MfaStepRegistry } = await import('@spinajs/authn');
    const steps = [];
    for (const step of (await this.Container.resolve(MfaStepRegistry)).steps()) steps.push({ name: step.name, enrolled: await step.enrolled(session.identity) });
    return new Ok({ steps }, { Headers: [NO_STORE] });
  }

  /**
   * Begin a TOTP enrolment
   * Body `{ reauthPassword? }`. Answers `{ provisioning }`, the otpauth URI, once; a later begin replaces a begun
   * enrolment with a new secret.
   * @security cookieAuth
   */
  @Post('mfa')
  // Decorators apply bottom up: the full-login group comes first, and a caller who passes neither hears its refusal.
  @Policy(PendingMfaEnrolment)
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async begin(@Req() req: Request) {
    const session = ownSession(req);
    const reauth = await reauthOf(this.Container, req, session);
    if ('answer' in reauth) return reauth.answer;
    const result = await (await totpServiceOf(this.Container)).begin(session.handle, contextOf(req, 'reauth', session.handle), reauth.credentials);
    if (!result.ok) return totpRefusal(result.code, { reauthTried: triedOn(session, reauth.credentials) });
    return new Ok({ provisioning: result.provisioning }, { Headers: [NO_STORE] });
  }

  /**
   * Confirm the TOTP enrolment
   * Body `{ code }`: a code of the begun secret. Answers `{ recoveryCodes }` once; each is single use.
   * @security cookieAuth
   */
  @Post('mfa/confirm')
  @Policy(PendingMfaEnrolment)
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async confirm(@Req() req: Request) {
    const session = ownSession(req);
    const code = codeField(req);
    if (code === null) return authnFailureResponse();
    const result = await (await totpServiceOf(this.Container)).confirm(session.handle, code, contextOf(req, 'reauth', session.handle));
    if (!result.ok) return totpRefusal(result.code, { reauthTried: false, retryAfterSeconds: result.retryAfterSeconds });
    return new Ok({ recoveryCodes: [...result.recoveryCodes] }, { Headers: [NO_STORE] });
  }

  /**
   * Disable TOTP
   * Body `{ code, reauthPassword? }`: a TOTP code or a recovery code. Removes the secret and the recovery codes.
   * @security cookieAuth
   */
  @Post('mfa/disable')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async disable(@Req() req: Request) {
    const session = activeSession(req);
    const reauth = await reauthOf(this.Container, req, session);
    if ('answer' in reauth) return reauth.answer;
    const code = codeField(req);
    if (code === null) return authnFailureResponse();
    const result = await (await totpServiceOf(this.Container)).disable(session.handle, code, contextOf(req, 'reauth', session.handle), reauth.credentials);
    if (!result.ok) return totpRefusal(result.code, { reauthTried: triedOn(session, reauth.credentials), retryAfterSeconds: result.retryAfterSeconds });
    return new Ok(null, { Headers: [NO_STORE] });
  }

  /**
   * New recovery codes
   * Body `{ reauthPassword? }`. Answers `{ recoveryCodes }` once and voids every older code.
   * @security cookieAuth
   */
  @Post('mfa/recovery-codes')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async recoveryCodes(@Req() req: Request) {
    const session = activeSession(req);
    const reauth = await reauthOf(this.Container, req, session);
    if ('answer' in reauth) return reauth.answer;
    const result = await (await totpServiceOf(this.Container)).regenerateRecoveryCodes(session.handle, contextOf(req, 'reauth', session.handle), reauth.credentials);
    if (!result.ok) return totpRefusal(result.code, { reauthTried: triedOn(session, reauth.credentials) });
    return new Ok({ recoveryCodes: [...result.recoveryCodes] }, { Headers: [NO_STORE] });
  }
}

/** The caller's session, active or pending; the policies have chosen which. */
function ownSession(req: Request): Restored {
  const session = req.storage.AuthnSession;
  if (!session) throw unauthenticated('this route needs a session');
  return session;
}

function activeSession(req: Request): Restored {
  const session = ownSession(req);
  if (session.handle.state !== 'active') throw refused('session_required', 'this route needs a session');
  return session;
}

/** TotpService re-authenticates only an active session, so a pending one that sent a password was never checked. */
const triedOn = (session: Restored, credentials: unknown): boolean => credentials !== undefined && session.handle.state === 'active';
