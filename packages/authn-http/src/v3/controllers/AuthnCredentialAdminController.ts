import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Ok, Param, Policy, Post, Req } from '@spinajs/http';
import { Hooks } from '@spinajs/hooks';
import { CREDENTIAL_ADMIN_REFUSALS, hookRefusalOf, runCredentialAdmin } from '@spinajs/authn/hooks';
import type { ActionName } from '@spinajs/hooks';
import type { Request } from '@spinajs/http';
import { MfaEnrolmentService, PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEventType, CredentialAdminAction, IdentityRef, Principal, PrincipalRef } from '@spinajs/authn/contracts';

import { guardRefusal, invalidSendReset, sendResetOf, targetNotFound, targetOf } from '../../admin/fields.js';
import { AdminMfaResetOn, CredentialAdminRuleRegistered, SessionIssuerRegistered } from '../../admin/gate.js';
import { PasswordServiceRegistered } from '../../password/gate.js';
import { freshAuthOrAnswer, takeReauthPassword } from '../../policies/v3/fresh-auth.js';
import { activeSessionOf, authenticatedPrincipal } from '../../policies/v3/principal.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, hookRefusedAnswer } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';
import '../../hooks.js';

/** authn-local declares it, and is no dependency of this package. */
const PASSWORD_EXPIRE: string = 'authn.password.expire';

/** The event a refused admin action is audited as. */
const REFUSED_EVENT: ReadonlyMap<CredentialAdminAction, AuthnEventType> = new Map<CredentialAdminAction, AuthnEventType>([
  ['password-reset', 'password.change'],
  ['mfa-reset', 'mfa.disable'],
  ['sessions', 'session.revoke'],
  ['tokens', 'token.revoke'],
]);

type Admitted = { readonly answer: unknown } | { readonly principal: Principal; readonly actor: PrincipalRef; readonly target: IdentityRef; readonly ctx: AuthnContext };
type Allowed = Exclude<Admitted, { readonly answer: unknown }>;

/**
 * Credential admin of another user (design §22.7, §22.8, §22.11; A25, SR-10). Off (404) while no CredentialAdminRule is
 * registered (users registers AuthzCredentialAdminRule), and each route while its own service is off. Every route
 * needs a full session of the admin: a token or key caller gets 403 `session_required`, an impersonation 403
 * `impersonating`, an anonymous caller or a pending session 401. Then, in this order: fresh auth (a login within
 * authn.freshAuth.maxAgeSeconds or the admin's password in `reauthPassword`; 403 `fresh_auth_required`, a wrong or
 * throttled password the login failure body without Retry-After), the `:uuid` (404 `not_found` unless a uuid), then the
 * `authn.admin.credentials` action: the CredentialAdminRule, its first before hook (403 `forbidden`, `protected_role` or
 * `escalation`, 404 `not_found`), the other hooks (403 `action_refused` with the hook's code), and only then the
 * effect, so a refused call changes nothing. Every answer the
 * routes build carries no-store and no secret. The admin is the audit actor.
 * @tags Authentication
 */
@BasePath({ config: 'authn.http.admin.basePath', default: 'authn/admin/users' })
@Policy(CredentialAdminRuleRegistered)
export class AuthnCredentialAdminController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(PasswordService, { optional: true })
  protected Passwords: PasswordService | undefined;

  @Autoinject(SessionIssuer, { optional: true })
  protected Sessions: SessionIssuer | undefined;

  @Autoinject(MfaEnrolmentService, { optional: true })
  protected MfaEnrolment: MfaEnrolmentService | undefined;

  @Autoinject(Hooks)
  protected Hooks!: Hooks;

  /**
   * Reset a user's password
   * Body `{ sendReset?, reauthPassword? }`. The current password stops working at once; every session of the user ends,
   * those where it impersonates included, and with authn.local.reset.revokeTokens every token. With `sendReset`
   * (default true) the owner gets a reset mail; the secret is never in this answer. Answers
   * `{ expired: true, resetMailRequested }`. `resetMailRequested` echoes `sendReset` only: the password service decides
   * whether a mail goes out (none without a PasswordMailer or for a user it finds not eligible). 400
   * `invalid_send_reset` for a `sendReset` that is not a boolean.
   * @body {AuthnPasswordResetAdminBody} Whether to mail a reset link, and the password for a stale session
   * @returns {AuthnPasswordResetAdminAnswer} The password is expired
   * @response 400 {AuthnError} invalid_send_reset
   * @security cookieAuth
   */
  @Post(':uuid/password-reset')
  @Policy([PasswordServiceRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async passwordReset(@Req() req: Request, @Param() uuid: string) {
    let sendReset = true;
    const admitted = await this.admit(req, uuid, 'password-reset', () => {
      const value = sendResetOf(req);
      if (value === null) return invalidSendReset();
      sendReset = value;
      return null;
    });
    if ('answer' in admitted) return admitted.answer;
    return this.effect(req, admitted, 'password-reset', async () => {
      await this.Passwords!.expire(admitted.target, { cause: 'admin', actor: admitted.actor, sendReset }, admitted.ctx);
      return { expired: true, resetMailRequested: sendReset };
    });
  }

  /**
   * Reset a user's TOTP
   * Removes the enrolment, confirmed or begun, and its recovery codes; the owner enrols again. Answers `{ reset }`, false
   * when there was nothing to remove. Never a secret. 404 while the MFA enrolment routes are off.
   * @body {AuthnReauthBody} The password, for a stale session
   * @returns {AuthnMfaResetAnswer} Whether there was an enrolment to remove
   * @security cookieAuth
   */
  @Post(':uuid/mfa-reset')
  @Policy([AdminMfaResetOn, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async mfaReset(@Req() req: Request, @Param() uuid: string) {
    const admitted = await this.admit(req, uuid, 'mfa-reset');
    if ('answer' in admitted) return admitted.answer;
    return this.effect(req, admitted, 'mfa-reset', async () => {
      const { reset } = await this.MfaEnrolment!.adminReset(admitted.actor, admitted.target, admitted.ctx);
      return { reset };
    });
  }

  /**
   * End a user's sessions
   * Every session of the user, those where it impersonates included. Answers `{ revoked }`, the count.
   * @body {AuthnReauthBody} The password, for a stale session
   * @returns {AuthnRevokedCount} The count of ended sessions
   * @security cookieAuth
   */
  @Del(':uuid/sessions')
  @Policy([SessionIssuerRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async sessions(@Req() req: Request, @Param() uuid: string) {
    const admitted = await this.admit(req, uuid, 'sessions');
    if ('answer' in admitted) return admitted.answer;
    return this.effect(req, admitted, 'sessions', async () => {
      const revoked = await this.Sessions!.revokeAll(admitted.target, { includeImpersonations: true });
      // SessionIssuer audits nothing.
      await publishAuthnEvent(this.Container, req, { type: 'session.revoke', outcome: 'success', reason: 'admin', identity: admitted.target, actor: admitted.actor, data: { count: revoked } });
      return { revoked };
    });
  }

  /**
   * Revoke a user's tokens
   * Every API and agent token of the user. Answers `{ revoked }`, the count.
   * @body {AuthnReauthBody} The password, for a stale session
   * @returns {AuthnRevokedCount} The count of revoked tokens
   * @security cookieAuth
   */
  @Del(':uuid/tokens')
  @Policy([TokenServiceRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async tokens(@Req() req: Request, @Param() uuid: string) {
    const admitted = await this.admit(req, uuid, 'tokens');
    if ('answer' in admitted) return admitted.answer;
    return this.effect(req, admitted, 'tokens', async () => {
      // Per call: apps that list no token strategy register no TokenService.
      const revoked = await (await this.Container.resolve(TokenService)).revokeAllFor(admitted.target, admitted.ctx, { actor: admitted.actor });
      return { revoked };
    });
  }

  /**
   * The effect, as the `authn.admin.credentials` action: its answer body; the rule's refusal (its codes are not audited,
   * as no guard refusal ever was); or 403 `{ code }` for another hook's refusal, also one of an action the effect runs
   * (an `authn.password.expire` hook).
   */
  protected async effect(req: Request, admitted: Allowed, action: CredentialAdminAction, run: () => Promise<Readonly<Record<string, unknown>>>) {
    try {
      return new Ok(await runCredentialAdmin(this.Hooks, { actor: admitted.principal, target: admitted.target, action }, run), { Headers: [NO_STORE] });
    } catch (err) {
      const own = hookRefusalOf(err, 'authn.admin.credentials');
      if (own && CREDENTIAL_ADMIN_REFUSALS.has(own.code)) return guardRefusal(own.code);
      // The expiry audits its own refusal.
      const refusal = own ?? hookRefusalOf(err, PASSWORD_EXPIRE as ActionName);
      if (!refusal) throw err;
      if (own) await publishAuthnEvent(this.Container, req, { type: REFUSED_EVENT.get(action) ?? 'session.revoke', outcome: 'failure', reason: refusal.reason, identity: admitted.target, actor: admitted.actor, data: { action } });
      return hookRefusedAnswer(refusal.code);
    }
  }

  /** Fresh auth, the target, then `fields`: the answer of the first that refuses, or what the effect needs. */
  protected async admit(req: Request, uuid: unknown, _action: CredentialAdminAction, fields?: () => unknown): Promise<Admitted> {
    const session = activeSessionOf(req);
    const fresh = await freshAuthOrAnswer(this.Container, req, takeReauthPassword(req));
    if ('answer' in fresh) return fresh;
    const target = targetOf(uuid);
    if (!target) return { answer: targetNotFound() };
    const invalid = fields?.();
    if (invalid) return { answer: invalid };
    const principal = authenticatedPrincipal(req);
    return { principal, actor: { type: principal.type, id: principal.id }, target, ctx: contextOf(req, 'request', session.handle) };
  }
}
