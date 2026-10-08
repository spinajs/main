import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Ok, Param, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { CredentialAdminGuard, PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, CredentialAdminAction, IdentityRef, PrincipalRef } from '@spinajs/authn/contracts';

import { guardRefusal, invalidSendReset, sendResetOf, targetNotFound, targetOf } from '../../admin/fields.js';
import { AdminMfaResetOn, CredentialAdminGuardRegistered, SessionIssuerRegistered, adminTotpServiceOf } from '../../admin/gate.js';
import { PasswordServiceRegistered } from '../../password/gate.js';
import { isAuthnFailed, refused } from '../../policies/v3/errors.js';
import { authenticatedPrincipal } from '../../policies/v3/principal.js';
import { takeReauthPassword } from '../../token/fields.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, assertFreshAuth } from '../index.js';
import { NO_STORE, authnFailureResponse } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';

type Admitted = { readonly answer: unknown } | { readonly actor: PrincipalRef; readonly target: IdentityRef; readonly ctx: AuthnContext };

/**
 * Credential admin of another user (design §22.7, §22.8, §22.11; A25, SR-10). Off (404) while no CredentialAdminGuard is
 * registered (users registers AuthzCredentialAdminGuard), and each route while its own service is off. Every route
 * needs a full session of the admin: a token or key caller gets 403 `session_required`, an impersonation 403
 * `impersonating`, an anonymous caller or a pending session 401. Then, in this order: fresh auth (a login within
 * authn.freshAuth.maxAgeSeconds or the admin's password in `reauthPassword`; 403 `fresh_auth_required`, a wrong or
 * throttled password the login failure body without Retry-After), the `:uuid` (404 `not_found` unless a uuid), the
 * guard (403 `forbidden`, `protected_role` or `escalation`, 404 `not_found`), and only then the effect, so a refused
 * call changes nothing. Every answer the routes build carries no-store and no secret. The admin is the audit actor.
 * @tags Authentication
 */
@BasePath('authn/admin/users')
@Policy(CredentialAdminGuardRegistered)
export class AuthnCredentialAdminController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.encryptionKey.secret')
  protected MfaEncryptionKey: string | null | undefined;

  /**
   * Reset a user's password
   * Body `{ sendReset?, reauthPassword? }`. The current password stops working at once; every session of the user ends,
   * those where it impersonates included, and with authn.local.reset.revokeTokens every token. With `sendReset`
   * (default true) the owner gets a reset mail; the secret is never in this answer. Answers
   * `{ expired: true, resetMailRequested }`. `resetMailRequested` echoes `sendReset` only: the password service decides
   * whether a mail goes out (none without a PasswordMailer or for a user it finds not eligible). 400
   * `invalid_send_reset` for a `sendReset` that is not a boolean.
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
    await (await this.Container.resolve(PasswordService)).expire(admitted.target, { cause: 'admin', actor: admitted.actor, sendReset }, admitted.ctx);
    return new Ok({ expired: true, resetMailRequested: sendReset }, { Headers: [NO_STORE] });
  }

  /**
   * Reset a user's TOTP
   * Removes the enrolment, confirmed or begun, and its recovery codes; the owner enrols again. Answers `{ reset }`, false
   * when there was nothing to remove. Never a secret. 404 while the MFA enrolment routes are off.
   * @security cookieAuth
   */
  @Post(':uuid/mfa-reset')
  @Policy([AdminMfaResetOn, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async mfaReset(@Req() req: Request, @Param() uuid: string) {
    const admitted = await this.admit(req, uuid, 'mfa-reset');
    if ('answer' in admitted) return admitted.answer;
    const { reset } = await (await adminTotpServiceOf(this.Container, this.MfaEncryptionKey)).adminReset(admitted.actor, admitted.target, admitted.ctx);
    return new Ok({ reset }, { Headers: [NO_STORE] });
  }

  /**
   * End a user's sessions
   * Every session of the user, those where it impersonates included. Answers `{ revoked }`, the count.
   * @security cookieAuth
   */
  @Del(':uuid/sessions')
  @Policy([SessionIssuerRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async sessions(@Req() req: Request, @Param() uuid: string) {
    const admitted = await this.admit(req, uuid, 'sessions');
    if ('answer' in admitted) return admitted.answer;
    const revoked = await (await this.Container.resolve(SessionIssuer)).revokeAll(admitted.target, { includeImpersonations: true });
    // SessionIssuer audits nothing.
    await publishAuthnEvent(this.Container, req, { type: 'session.revoke', outcome: 'success', reason: 'admin', identity: admitted.target, actor: admitted.actor, data: { count: revoked } });
    return new Ok({ revoked }, { Headers: [NO_STORE] });
  }

  /**
   * Revoke a user's tokens
   * Every API and agent token of the user. Answers `{ revoked }`, the count.
   * @security cookieAuth
   */
  @Del(':uuid/tokens')
  @Policy([TokenServiceRegistered, Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async tokens(@Req() req: Request, @Param() uuid: string) {
    const admitted = await this.admit(req, uuid, 'tokens');
    if ('answer' in admitted) return admitted.answer;
    const revoked = await (await this.Container.resolve(TokenService)).revokeAllFor(admitted.target, admitted.ctx, { actor: admitted.actor });
    return new Ok({ revoked }, { Headers: [NO_STORE] });
  }

  /** Fresh auth, the target, `fields`, then the guard: the answer of the first that refuses, or what the effect needs. */
  protected async admit(req: Request, uuid: unknown, action: CredentialAdminAction, fields?: () => unknown): Promise<Admitted> {
    const session = req.storage.AuthnSession;
    if (session?.handle.state !== 'active') throw refused('session_required', 'this route needs a session');
    const password = takeReauthPassword(req);
    try {
      // In the handler, not as a FreshAuth policy: http runs every policy of a route at once, so the policy would verify
      // a password while a gate answers 404.
      await assertFreshAuth(this.Container, req, undefined, password);
    } catch (err) {
      // The thrown error's body carries a stack outside production; login's answer never does.
      if (isAuthnFailed(err)) return { answer: authnFailureResponse() };
      throw err;
    }
    const target = targetOf(uuid);
    if (!target) return { answer: targetNotFound() };
    const invalid = fields?.();
    if (invalid) return { answer: invalid };
    const principal = authenticatedPrincipal(req);
    const verdict = await (await this.Container.resolve(CredentialAdminGuard)).allowed(principal, target, action);
    // A guard written past the types may answer anything; only `ok: true` opens the effect.
    if (verdict?.ok !== true) return { answer: guardRefusal(verdict?.code) };
    return { actor: { type: principal.type, id: principal.id }, target, ctx: contextOf(req, 'request', session.handle) };
  }
}
