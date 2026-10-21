import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Ok, Param, Policy, Post } from '@spinajs/http';
import { CredentialAdminGuard, MfaEnrolmentService, PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, CredentialAdminAction, IdentityRef, PrincipalRef } from '@spinajs/authn/contracts';

import { guardRefusal, invalidSendReset, targetNotFound } from '../../admin/fields.js';
import { AdminMfaResetOn, CredentialAdminGuardRegistered, SessionIssuerRegistered } from '../../admin/gate.js';
import { ClientContext } from '../../args/authn.js';
import { AuthnAdminPasswordResetBody, USER_ID_PARAM } from '../../dto/credential-admin.js';
import { AuthnReauthPasswordBody } from '../../dto/reauth.js';
import { PasswordServiceRegistered } from '../../password/gate.js';
import { freshAuthOrAnswer } from '../../policies/v3/fresh-auth.js';
import { activeSessionOf, authenticatedPrincipal } from '../../policies/v3/principal.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { OnInvalidInput, byField, bySchema, unknownField } from '../../validation/answers.js';
import type { InputAnswer } from '../../validation/answers.js';
import { uniformFailure } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';

type Admitted = { readonly answer: unknown } | { readonly actor: PrincipalRef; readonly target: IdentityRef; readonly ctx: AuthnContext };

/** The `:uuid` first (it is the last parameter, and route args are extracted from the last on): 404, as before. */
const refusedInput = (fields: Readonly<Record<string, InputAnswer>>): InputAnswer => bySchema(USER_ID_PARAM.$id, targetNotFound, byField({ reauthPassword: uniformFailure, ...fields }, unknownField));

/**
 * Credential admin of another user (design §22.7, §22.8, §22.11; A25, SR-10). Off (404) while no CredentialAdminGuard is
 * registered (users registers AuthzCredentialAdminGuard), and each route while its own service is off. Every route
 * needs a full session of the admin: a token or key caller gets 403 `session_required`, an impersonation 403
 * `impersonating`, an anonymous caller or a pending session 401. Then the input: the `:uuid` (404 `not_found` unless a
 * uuid) and the body (400 `invalid_send_reset`, `invalid_field`; a reauthPassword that is no string the login failure
 * body). Then, in this order: fresh auth (a login within authn.freshAuth.maxAgeSeconds or the admin's password in
 * `reauthPassword`; 403 `fresh_auth_required`, a wrong or throttled password the login failure body without
 * Retry-After), the guard (403 `forbidden`, `protected_role` or `escalation`, 404 `not_found`), and only then the
 * effect, so a refused call changes nothing. Every answer the routes build carries no-store and no secret. The admin is the audit actor.
 * @tags Authentication
 */
@BasePath({ config: 'authn.http.admin.basePath', default: 'authn/admin/users' })
@Policy(CredentialAdminGuardRegistered)
export class AuthnCredentialAdminController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(PasswordService, { optional: true })
  protected Passwords: PasswordService | undefined;

  @Autoinject(SessionIssuer, { optional: true })
  protected Sessions: SessionIssuer | undefined;

  @Autoinject(CredentialAdminGuard, { optional: true })
  protected Guard: CredentialAdminGuard | undefined;

  @Autoinject(MfaEnrolmentService, { optional: true })
  protected MfaEnrolment: MfaEnrolmentService | undefined;

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
  @OnInvalidInput(refusedInput({ sendReset: invalidSendReset }))
  public async passwordReset(@Body({ sensitive: ['reauthPassword'] }) body: AuthnAdminPasswordResetBody, @ClientContext() client: AuthnClientContext, @Param(USER_ID_PARAM) uuid: string) {
    const input = body as AuthnAdminPasswordResetBody | null;
    const sendReset = input?.sendReset ?? true;
    const admitted = await this.admit(client, uuid, 'password-reset', input?.reauthPassword);
    if ('answer' in admitted) return admitted.answer;
    await this.Passwords!.expire(admitted.target, { cause: 'admin', actor: admitted.actor, sendReset }, admitted.ctx);
    return new Ok({ expired: true, resetMailRequested: sendReset }, { Headers: [NO_STORE] });
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
  @OnInvalidInput(refusedInput({}))
  public async mfaReset(@Body({ sensitive: ['reauthPassword'] }) body: AuthnReauthPasswordBody, @ClientContext() client: AuthnClientContext, @Param(USER_ID_PARAM) uuid: string) {
    const admitted = await this.admit(client, uuid, 'mfa-reset', (body as AuthnReauthPasswordBody | null)?.reauthPassword);
    if ('answer' in admitted) return admitted.answer;
    const { reset } = await this.MfaEnrolment!.adminReset(admitted.actor, admitted.target, admitted.ctx);
    return new Ok({ reset }, { Headers: [NO_STORE] });
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
  @OnInvalidInput(refusedInput({}))
  public async sessions(@Body({ sensitive: ['reauthPassword'] }) body: AuthnReauthPasswordBody, @ClientContext() client: AuthnClientContext, @Param(USER_ID_PARAM) uuid: string) {
    const admitted = await this.admit(client, uuid, 'sessions', (body as AuthnReauthPasswordBody | null)?.reauthPassword);
    if ('answer' in admitted) return admitted.answer;
    const revoked = await this.Sessions!.revokeAll(admitted.target, { includeImpersonations: true });
    // SessionIssuer audits nothing.
    await publishAuthnEvent(this.Container, client, { type: 'session.revoke', outcome: 'success', reason: 'admin', identity: admitted.target, actor: admitted.actor, data: { count: revoked } });
    return new Ok({ revoked }, { Headers: [NO_STORE] });
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
  @OnInvalidInput(refusedInput({}))
  public async tokens(@Body({ sensitive: ['reauthPassword'] }) body: AuthnReauthPasswordBody, @ClientContext() client: AuthnClientContext, @Param(USER_ID_PARAM) uuid: string) {
    const admitted = await this.admit(client, uuid, 'tokens', (body as AuthnReauthPasswordBody | null)?.reauthPassword);
    if ('answer' in admitted) return admitted.answer;
    // Per call: apps that list no token strategy register no TokenService.
    const revoked = await (await this.Container.resolve(TokenService)).revokeAllFor(admitted.target, admitted.ctx, { actor: admitted.actor });
    return new Ok({ revoked }, { Headers: [NO_STORE] });
  }

  /** Fresh auth, then the guard: the answer of the first that refuses, or what the effect needs. */
  protected async admit(client: AuthnClientContext, uuid: string, action: CredentialAdminAction, reauthPassword: string | undefined): Promise<Admitted> {
    const session = activeSessionOf(client);
    const fresh = await freshAuthOrAnswer(this.Container, client, reauthPassword);
    if ('answer' in fresh) return fresh;
    const target: IdentityRef = { type: 'user', id: uuid };
    const principal = authenticatedPrincipal(client);
    const verdict = await this.Guard!.allowed(principal, target, action);
    // A guard written past the types may answer anything; only `ok: true` opens the effect.
    if (verdict?.ok !== true) return { answer: guardRefusal(verdict?.code) };
    return { actor: { type: principal.type, id: principal.id }, target, ctx: contextOf(client, 'request', session.handle) };
  }
}
