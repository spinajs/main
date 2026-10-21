import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { MfaEnrolmentService } from '@spinajs/authn/contracts';
import type { Session } from '@spinajs/authn/contracts';

import { TotpEnrolmentOn, codeField, reauthOf, totpRefusal } from '../../mfa/index.js';
import { unauthenticated } from '../../policies/v3/errors.js';
import { mfaPolicyOf } from '../../policies/v3/mfa.js';
import { takeReauthPassword } from '../../policies/v3/fresh-auth.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, PendingMfaEnrolment } from '../index.js';
import { NO_STORE, authnFailureResponse } from '../responses.js';
import { contextOf } from '../routes.js';
import { clientOf } from '../client.js';

/**
 * The owner's TOTP enrolment over the MfaEnrolmentService, authn-totp's TotpService (design §22.8, §22.11; A09, A10,
 * A13). Off (404) unless one is registered and login asks for its step (`mfaEnrolmentOn`: authn.mfa.steps lists
 * authn-totp's TotpMfaStep, that class, not a subclass, and authn.mfa.encryptionKey is set). Every route acts on the
 * identity of the caller's own session: a token or key caller gets 403 `session_required`, an impersonation 403
 * `impersonating` (a factor enrolled there would lock the owner out).
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
@Policy(TotpEnrolmentOn)
export class AuthnMfaEnrolmentController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(MfaEnrolmentService, { optional: true })
  protected MfaEnrolment: MfaEnrolmentService | undefined;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  /**
   * MFA status
   * `{ steps: [{ name, enrolled }] }` for each step of authn.mfa.steps; a begun but unconfirmed enrolment is not
   * enrolled. Never a secret.
   * @returns {AuthnMfaStatus} Each configured step and whether the caller is enrolled in it
   * @security cookieAuth
   */
  @Get('mfa')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async status(@Req() req: Request) {
    const session = activeSessionOf(clientOf(req));
    const steps = [];
    for (const step of (await (await mfaPolicyOf(this.Container, this.MfaPolicyService)).steps()).values()) steps.push({ name: step.name, enrolled: await step.enrolled(session.identity) });
    return new Ok({ steps }, { Headers: [NO_STORE] });
  }

  /**
   * Begin a TOTP enrolment
   * Body `{ reauthPassword? }`. Answers `{ provisioning }`, the otpauth URI, once; a later begin replaces a begun
   * enrolment with a new secret.
   * @body {AuthnReauthBody} The password, for a stale session
   * @returns {AuthnMfaProvisioning} The otpauth URI
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} fresh_auth_required, enrolment_closed, session_required or impersonating
   * @response 409 {AuthnError} mfa_enrolled
   * @security cookieAuth
   */
  @Post('mfa')
  // The groups are ORed. A caller who passes neither hears the group that authenticated it: an enrolled pending session
  // gets PendingMfaEnrolment's 403 enrolment_closed, an anonymous caller the 401.
  @Policy(PendingMfaEnrolment)
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async begin(@Req() req: Request) {
    const session = ownSession(req);
    const reauth = await reauthOf(this.Container, clientOf(req), session, takeReauthPassword(req));
    if ('answer' in reauth) return reauth.answer;
    const result = await this.MfaEnrolment!.begin(session.handle, contextOf(clientOf(req), 'reauth', session.handle), reauth.credentials);
    if (!result.ok) return totpRefusal(result.code, { reauthTried: reauth.credentials !== undefined });
    return new Ok({ provisioning: result.provisioning }, { Headers: [NO_STORE] });
  }

  /**
   * Confirm the TOTP enrolment
   * Body `{ code }`: a code of the begun secret. Answers `{ recoveryCodes }` once; each is single use.
   * @body {AuthnMfaCodeBody} A code of the begun secret
   * @returns {AuthnRecoveryCodes} The recovery codes, shown once
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} enrolment_closed, session_required or impersonating
   * @response 409 {AuthnError} mfa_enrolled or mfa_not_begun
   * @security cookieAuth
   */
  @Post('mfa/confirm')
  @Policy(PendingMfaEnrolment)
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async confirm(@Req() req: Request) {
    const session = ownSession(req);
    const code = codeField(req);
    if (code === null) return authnFailureResponse();
    const result = await this.MfaEnrolment!.confirm(session.handle, code, contextOf(clientOf(req), 'reauth', session.handle));
    if (!result.ok) return totpRefusal(result.code, { reauthTried: false, retryAfterSeconds: result.retryAfterSeconds });
    return new Ok({ recoveryCodes: [...result.recoveryCodes] }, { Headers: [NO_STORE] });
  }

  /**
   * Disable TOTP
   * Body `{ code, reauthPassword? }`: a TOTP code or a recovery code. Removes the secret and the recovery codes.
   * @body {AuthnMfaDisableBody} A TOTP code or a recovery code, and the password for a stale session
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} fresh_auth_required, session_required or impersonating
   * @response 409 {AuthnError} mfa_not_enrolled
   * @security cookieAuth
   */
  @Post('mfa/disable')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async disable(@Req() req: Request) {
    const session = activeSessionOf(clientOf(req));
    const reauth = await reauthOf(this.Container, clientOf(req), session, takeReauthPassword(req));
    if ('answer' in reauth) return reauth.answer;
    const code = codeField(req);
    if (code === null) return authnFailureResponse();
    const result = await this.MfaEnrolment!.disable(session.handle, code, contextOf(clientOf(req), 'reauth', session.handle), reauth.credentials);
    if (!result.ok) return totpRefusal(result.code, { reauthTried: reauth.credentials !== undefined, retryAfterSeconds: result.retryAfterSeconds });
    return new Ok(null, { Headers: [NO_STORE] });
  }

  /**
   * New recovery codes
   * Body `{ reauthPassword? }`. Answers `{ recoveryCodes }` once and voids every older code.
   * @body {AuthnReauthBody} The password, for a stale session
   * @returns {AuthnRecoveryCodes} New recovery codes, shown once
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} fresh_auth_required, session_required or impersonating
   * @response 409 {AuthnError} mfa_not_enrolled
   * @security cookieAuth
   */
  @Post('mfa/recovery-codes')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async recoveryCodes(@Req() req: Request) {
    const session = activeSessionOf(clientOf(req));
    const reauth = await reauthOf(this.Container, clientOf(req), session, takeReauthPassword(req));
    if ('answer' in reauth) return reauth.answer;
    const result = await this.MfaEnrolment!.regenerateRecoveryCodes(session.handle, contextOf(clientOf(req), 'reauth', session.handle), reauth.credentials);
    if (!result.ok) return totpRefusal(result.code, { reauthTried: reauth.credentials !== undefined });
    return new Ok({ recoveryCodes: [...result.recoveryCodes] }, { Headers: [NO_STORE] });
  }
}

/** The caller's session, active or pending; the policies have chosen which. */
function ownSession(req: Request): Session {
  const session = req.storage.AuthnSession;
  if (!session) throw unauthenticated('this route needs a session');
  return session;
}
