import { Config } from '@spinajs/configuration';
import '../../register-schema.js';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Body, BotCheck, Policy, Post } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { AuthnThrottle, IdentityRegistrar, PasswordService, ipKey, ipv6PrefixOf } from '@spinajs/authn/contracts';
import type { AuthnContext, PasswordViolation } from '@spinajs/authn/contracts';
import { ActionHookFailed, ActionRefused, Hooks } from '@spinajs/hooks';
import { hookRefusalOf, runHookedAction } from '@spinajs/authn/hooks';

import { ClientContext } from '../../args/authn.js';
import { AuthnRegistrationBody, IDENTIFIER_CAP } from '../../dto/registration.js';
import { mismatchOf, newPasswordRefused, passwordMismatch, passwordRejected, tooManyRequests } from '../../password/fields.js';
import { IdentityRegistrarRegistered } from '../../policies/v3/groups.js';
import { IpThrottle } from '../../middleware/ip-throttle.js';
import { OnInvalidInput, byField, invalid, unknownField } from '../../validation/answers.js';
import type { AuthnClientContext } from '../client.js';
import { AcceptedResponse, NO_STORE, hookRefusedAnswer } from '../responses.js';
import { contextOf, publishAuthnEvent } from '../routes.js';
import type { RegistrationInput, RegistrationOutput } from '../../hooks.js';
// Registers the mails of a registration, an after hook on authn.registration.
import '../registration-mail-hook.js';

/**
 * A refusal of an action the registrar runs (users.create, authn.password.set): an ActionRefused or ActionHookFailed
 * escaping it, or the InvalidArgument on the password users makes of a refused set; the route checked the policy itself.
 */
function nestedRefusalOf(err: unknown): { reason: string; action?: string } | null {
  if (err instanceof ActionRefused) return { reason: `hook:${err.code}`, action: err.action };
  if (err instanceof ActionHookFailed) return { reason: 'hook_error', action: err.action };
  if (err instanceof InvalidArgument && err.fieldName === 'password') return { reason: 'password_refused' };
  return null;
}

/** The password breaks the policy for the login or email a hook set. */
class RejectedForHookedValues extends Error {
  constructor(readonly violations: readonly PasswordViolation[]) {
    super('the password breaks the policy for the registration the hooks left');
  }
}

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

  @Config('authn.throttle.ipv6Prefix')
  protected ThrottleIpv6Prefix: unknown;

  @Autoinject(Hooks)
  protected Hooks!: Hooks;

  /**
   * Register
   * Body `{ login, email, password, confirmPassword? }`. Answers 202 `{ status: 'accepted' }` whether the account is new or
   * the address is taken, so it tells a stranger nothing about who has an account. RegistrationMailHook, an
   * `authn.registration` after hook, sends a new account a verification mail and the owner of a taken address an
   * account-exists mail (`authn.http.registration.notifyExisting`). A
   * password that breaks the policy answers 400 `password_rejected` with its violations: they depend on the input only. 429
   * with Retry-After when throttled (the `register` flow, per address and per client ip). An `authn.registration` hook
   * may change `login` and `email` (checked again against the policy, then by the registrar) or refuse: 400
   * `action_refused` with `code`.
   * @response 202 {AuthnRegistrationAnswer} Always { status: 'accepted' }
   * @response 400 {AuthnError} invalid_login, invalid_email, invalid_password, password_mismatch, password_rejected, invalid_field, invalid_registration or action_refused
   * @security []
   */
  @Post('auth/register')
  @BotCheck('register')
  @IpThrottle('register', (retryAfter) => tooManyRequests('too many registrations, try again later', retryAfter))
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
    const gate = await throttle.attempt([{ kind: 'account', value: `register:${email.trim().toLowerCase()}` }, ipKey(ctx, ipv6PrefixOf(this.ThrottleIpv6Prefix)) ?? { kind: 'ip', value: 'unknown' }], 'register', ctx);
    if (!gate.allowed) return tooManyRequests('too many registrations, try again later', gate.retryAfterSeconds);

    const passwords = await this.Container.resolve(PasswordService);
    const violations = await passwords.check(password, { login, email });
    if (violations.length > 0) return passwordRejected(violations);

    let result: RegistrationOutput;
    try {
      result = await runHookedAction(this.Hooks, 'authn.registration', { login, email, ctx }, (input) => this.registered(passwords, input, { login, email }, password, ctx), { mutable: ['login', 'email'] });
    } catch (err) {
      return this.refused(client, err);
    }

    const created = result.status === 'created';
    await publishAuthnEvent(this.Container, client, { type: 'identity.register', outcome: created ? 'success' : 'failure', identity: result.id, ...(created ? {} : { reason: 'exists' }) });
    return new AcceptedResponse({ status: 'accepted' }, { Headers: [NO_STORE] });
  }

  /** The answer to a registration that threw; an error that is no refusal is rethrown. */
  private async refused(client: AuthnClientContext, err: unknown) {
    if (err instanceof RejectedForHookedValues) return passwordRejected(err.violations);
    const refusal = hookRefusalOf(err, 'authn.registration');
    if (refusal) {
      await publishAuthnEvent(this.Container, client, { type: 'identity.register', outcome: 'failure', reason: refusal.reason });
      return hookRefusedAnswer(refusal.code, 400);
    }
    // Only a new address reaches what the registrar runs inside it, so its refusals answer as a taken one does.
    const nested = nestedRefusalOf(err);
    if (nested) {
      await publishAuthnEvent(this.Container, client, { type: 'identity.register', outcome: 'failure', reason: nested.reason, ...(nested.action ? { data: { action: nested.action } } : {}) });
      return new AcceptedResponse({ status: 'accepted' }, { Headers: [NO_STORE] });
    }
    if (err instanceof InvalidArgument) return new BadRequestResponse({ error: 'invalid_registration', message: 'the registration was refused', ...(err.fieldName ? { field: err.fieldName } : {}) }, { Headers: [NO_STORE] });
    throw err;
  }

  /** The registration with the login and email the hooks left; values a hook changed meet the password policy again. */
  private async registered(passwords: PasswordService, input: RegistrationInput, asked: { login: string; email: string }, password: string, ctx: AuthnContext): Promise<RegistrationOutput> {
    const { login, email } = input;
    if (typeof login !== 'string' || typeof email !== 'string') throw new InvalidArgument('login and email must be strings', typeof login !== 'string' ? 'login' : 'email');
    if (login !== asked.login || email !== asked.email) {
      const violations = await passwords.check(password, { login, email });
      if (violations.length > 0) throw new RejectedForHookedValues(violations);
    }
    return (await this.Container.resolve(IdentityRegistrar)).register({ login, email, password }, ctx);
  }
}
