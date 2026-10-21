import { Config } from '@spinajs/configuration';
import '../../register-schema.js';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { AuthnThrottle, IdentityRegistrar, PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PasswordViolation } from '@spinajs/authn/contracts';
import { Hooks } from '@spinajs/hooks';

import { newPasswordField, passwordRejected, tooManyRequests } from '../../password/fields.js';
import { IdentityRegistrarRegistered } from '../../policies/v3/groups.js';
import { AcceptedResponse, NO_STORE, badRequest, hookRefusalOf, hookRefusedAnswer } from '../responses.js';
import { bodyField, boundedString, contextOf, publishAuthnEvent } from '../routes.js';
import type { RegistrationInput, RegistrationOutput } from '../../hooks.js';

const IDENTIFIER_CAP = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

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

  @Config('authn.http.registration.notifyExisting')
  protected NotifyExisting: boolean;

  @Autoinject(Hooks)
  protected Hooks!: Hooks;

  /**
   * Register
   * Body `{ login, email, password, confirmPassword? }`. Answers 202 `{ status: 'accepted' }` whether the account is new or
   * the address is taken, so it tells a stranger nothing about who has an account. A new account is sent a verification
   * mail; the owner of a taken address is sent an account-exists mail (`authn.http.registration.notifyExisting`). A
   * password that breaks the policy answers 400 `password_rejected` with its violations: they depend on the input only. 429
   * with Retry-After when throttled (the `reset` flow, per address and per client ip). An `authn.registration` hook may
   * change `login` and `email` (checked again against the policy, then by the registrar) or refuse: 400 `action_refused`
   * with `code`.
   * @security []
   */
  @Post('auth/register')
  public async register(@Req() req: Request) {
    const login = boundedString(bodyField(req, 'login'), IDENTIFIER_CAP);
    if (login === null) return badRequest('invalid_login', `login must be a non-empty string of at most ${IDENTIFIER_CAP} characters`);
    const email = boundedString(bodyField(req, 'email'), IDENTIFIER_CAP);
    if (email === null || !EMAIL_SHAPE.test(email)) return badRequest('invalid_email', 'email must be an email address');
    const next = newPasswordField(req);
    if ('answer' in next) return next.answer;

    const ctx = contextOf(req, 'request');
    const throttle = await this.Container.resolve(AuthnThrottle);
    const gate = await throttle.attempt([{ kind: 'account', value: `register:${email.trim().toLowerCase()}` }, { kind: 'ip', value: ctx.ip ?? 'unknown' }], 'reset', ctx);
    if (!gate.allowed) return tooManyRequests('too many registrations, try again later', gate.retryAfterSeconds);

    const passwords = await this.Container.resolve(PasswordService);
    const violations = await passwords.check(next.password, { login, email });
    if (violations.length > 0) return passwordRejected(violations);

    let result: RegistrationOutput;
    try {
      result = await this.Hooks.run('authn.registration', { login, email, ctx }, (input) => this.registered(passwords, input, { login, email }, next.password, ctx), { mutable: ['login', 'email'] });
    } catch (err) {
      if (err instanceof RejectedForHookedValues) return passwordRejected(err.violations);
      if (err instanceof InvalidArgument) return new BadRequestResponse({ error: 'invalid_registration', message: 'the registration was refused', ...(err.fieldName ? { field: err.fieldName } : {}) }, { Headers: [NO_STORE] });
      const refusal = hookRefusalOf(err, 'authn.registration');
      if (!refusal) throw err;
      await publishAuthnEvent(this.Container, req, { type: 'identity.register', outcome: 'failure', reason: refusal.reason });
      return hookRefusedAnswer(refusal.code, 400);
    }

    const created = result.status === 'created';
    await publishAuthnEvent(this.Container, req, { type: 'identity.register', outcome: created ? 'success' : 'failure', identity: result.id, ...(created ? {} : { reason: 'exists' }) });
    await this.mail(passwords, result.id, created, ctx);
    return new AcceptedResponse({ status: 'accepted' }, { Headers: [NO_STORE] });
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
