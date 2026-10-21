import { Config } from '@spinajs/configuration';
import '../../register-schema.js';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Body, BotCheck, Policy, Post } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { AuthnThrottle, IdentityRegistrar, PasswordService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnRegistrationBody, IDENTIFIER_CAP } from '../../dto/registration.js';
import { mismatchOf, newPasswordRefused, passwordMismatch, passwordRejected, tooManyRequests } from '../../password/fields.js';
import { IdentityRegistrarRegistered } from '../../policies/v3/groups.js';
import { OnInvalidInput, byField, invalid, unknownField } from '../../validation/answers.js';
import type { AuthnClientContext } from '../client.js';
import { AcceptedResponse, NO_STORE } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';

/**
 * Self-service registration over the IdentityRegistrar contract (FEAT-4, A35). Off (404) while none is registered, or the
 * registered one is switched off (`users.registration.enabled`).
 * @tags Authentication
 */
@BasePath('/')
@Policy(IdentityRegistrarRegistered)
export class AuthnRegistrationController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.http.registration.notifyExisting')
  protected NotifyExisting: boolean;

  /**
   * Register
   * Body `{ login, email, password, confirmPassword? }`. Answers 202 `{ status: 'accepted' }` whether the account is new or
   * the address is taken, so it tells a stranger nothing about who has an account. A new account is sent a verification
   * mail; the owner of a taken address is sent an account-exists mail (`authn.http.registration.notifyExisting`). A
   * password that breaks the policy answers 400 `password_rejected` with its violations: they depend on the input only. 429
   * with Retry-After when throttled (the `reset` flow, per address and per client ip).
   * @security []
   */
  @Post('auth/register')
  @BotCheck('register')
  @OnInvalidInput(
    byField(
      {
        login: invalid('invalid_login', `login must be a non-empty string of at most ${IDENTIFIER_CAP} characters`),
        email: invalid('invalid_email', 'email must be an email address'),
        password: newPasswordRefused,
        confirmPassword: passwordMismatch,
      },
      unknownField,
    ),
  )
  public async register(@Body({ required: true }) body: AuthnRegistrationBody, @ClientContext() client: AuthnClientContext) {
    const mismatch = mismatchOf(body);
    if (mismatch) return mismatch;
    const { login, email, password } = body;

    const ctx = contextOf(client, 'request');
    const throttle = await this.Container.resolve(AuthnThrottle);
    const gate = await throttle.attempt([{ kind: 'account', value: `register:${email.trim().toLowerCase()}` }, { kind: 'ip', value: ctx.ip ?? 'unknown' }], 'reset', ctx);
    if (!gate.allowed) return tooManyRequests('too many registrations, try again later', gate.retryAfterSeconds);

    const passwords = await this.Container.resolve(PasswordService);
    const violations = await passwords.check(password, { login, email });
    if (violations.length > 0) return passwordRejected(violations);

    let result: Awaited<ReturnType<IdentityRegistrar['register']>>;
    try {
      result = await (await this.Container.resolve(IdentityRegistrar)).register({ login, email, password }, ctx);
    } catch (err) {
      if (!(err instanceof InvalidArgument)) throw err;
      return new BadRequestResponse({ error: 'invalid_registration', message: 'the registration was refused', ...(err.fieldName ? { field: err.fieldName } : {}) }, { Headers: [NO_STORE] });
    }

    const created = result.status === 'created';
    await publishAuthnEvent(this.Container, client, { type: 'identity.register', outcome: created ? 'success' : 'failure', identity: result.id, ...(created ? {} : { reason: 'exists' }) });
    await this.mail(passwords, result.id, created, ctx);
    return new AcceptedResponse({ status: 'accepted' }, { Headers: [NO_STORE] });
  }

  // The answer is the same whether or not a mail goes out, so a failing queue is logged and not shown.
  private async mail(passwords: PasswordService, id: IdentityRef, created: boolean, ctx: ReturnType<typeof contextOf>): Promise<void> {
    try {
      if (created) await passwords.requestVerification?.(id, ctx);
      else if (this.NotifyExisting !== false) await passwords.notifyAccountExists?.(id, ctx);
    } catch (err) {
      this._log.warn({ errorName: (err as Error)?.name ?? typeof err }, 'A registration mail could not be requested: ${errorName}');
    }
  }
}
