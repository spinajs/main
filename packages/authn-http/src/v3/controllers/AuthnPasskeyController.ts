import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, BotCheck, Conflict, Del, Get, NotFound, Ok, Param, Policy, Post } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { AuthnService, AuthnThrottle, PasskeyChallengesFull, PasskeyService, SessionIssuer, ipKey, ipv6PrefixOf } from '@spinajs/authn/contracts';
import type { PasskeyCeremony, PasskeyEntry } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnPasskeyLoginBody, AuthnPasskeyRegisterBody, PASSKEY_ID_PARAM, PASSKEY_NAME_CAP } from '../../dto/passkeys.js';
import { AuthnReauthPasswordBody } from '../../dto/reauth.js';
import { keyManager } from '../../keys/fields.js';
import { notFound } from '../../policies/v3/errors.js';
import { serviceRegistered } from '../../policies/v3/groups.js';
import { freshAuthOrAnswer } from '../../policies/v3/fresh-auth.js';
import { OnInvalidInput, byField, invalid, unknownField } from '../../validation/answers.js';
import { failedLogin, uniformFailure } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { tooManyRequests } from '../../password/fields.js';
import { NO_STORE, ServiceUnavailableResponse, badRequest, instant } from '../responses.js';
import { completeLogin, contextOf } from '../routes.js';

const invalidResponse = invalid('invalid_response', 'challengeId and response are required');
const invalidName = invalid('invalid_name', `name must be 1 to ${PASSKEY_NAME_CAP} characters without control characters`);

/**
 * 404 `not_found` while no PasskeyService is registered or authn.strategies lists no strategy for `webauthn`
 * credentials: a passkey registered there could never log in.
 */
export class PasskeyRoutesOn extends serviceRegistered(PasskeyService, 'the passkey routes are off') {
  public async execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    await super.execute(req, action, instance);
    const authn = await this.Container.resolve(AuthnService);
    if (!authn.strategies().some((s) => s.kinds.includes('webauthn'))) throw notFound('not_found', 'the passkey routes are off');
  }
}

const ceremonyAnswer = (c: PasskeyCeremony): Ok => new Ok({ challengeId: c.challengeId, options: c.options }, { Headers: [NO_STORE] });

const passkeyEntry = (p: PasskeyEntry): Record<string, unknown> => ({ id: p.id, name: p.name ?? null, transports: p.transports ? [...p.transports] : [], createdAt: instant(p.createdAt), lastUsedAt: instant(p.lastUsedAt) });

const passkeyNotFound = (): NotFound => new NotFound({ error: 'passkey_not_found', message: 'No such passkey' }, { Headers: [NO_STORE] });

/**
 * Passkeys over the PasskeyService contract (authn-webauthn's WebAuthnPasskeyService; A02, A13, A33). Off (404) unless
 * one is registered and a strategy takes `webauthn` credentials (`PasskeyRoutesOn`). The `/user/passkeys` routes act on
 * the caller's own session: a token or key caller gets 403 `session_required`, an impersonation 403 `impersonating`, an
 * anonymous caller or a pending session 401. Registration needs fresh auth: a login within authn.freshAuth.maxAgeSeconds
 * or the account password in `reauthPassword`. Every answer carries no-store.
 *
 * Login is two calls: POST /auth/passkeys/challenge answers `{ challengeId, options }` for
 * navigator.credentials.get(), and POST /auth/passkeys/login takes `{ challengeId, response }`. A passkey with user
 * verification logs in at aal2, without it at aal1.
 * @tags Authentication
 */
@BasePath('/')
@Policy(PasskeyRoutesOn)
export class AuthnPasskeyController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Config('authn.throttle.ipv6Prefix')
  protected ThrottleIpv6Prefix: unknown;

  private storeFullLogged = false;

  /**
   * Passkey challenge
   * Anonymous: assertion options for any discoverable credential. With a pending session, a challenge for the WebAuthn
   * MFA step that allows only that identity's credentials; its answer goes to POST /auth/mfa/verify as the step code.
   * Answers `{ challengeId, options }`. An anonymous caller counts in the `login` throttle on its ip: 429 with Retry-After
   * when refused. 503 with Retry-After while the stored challenges are at `authn.webauthn.challenges.maxRows`.
   * @security []
   */
  @Post('auth/passkeys/challenge')
  @BotCheck('passkey_challenge')
  public async challenge(@ClientContext() client: AuthnClientContext) {
    const passkeys = await this.passkeys();
    const session = client.session;
    if (session?.handle.state === 'pending') return ceremonyAnswer(await passkeys.challenge(contextOf(client, 'login', session.handle), session.identity));

    const ctx = contextOf(client, 'login');
    const ip = ipKey(ctx, ipv6PrefixOf(this.ThrottleIpv6Prefix));
    if (ip) {
      const gate = await (await this.Container.resolve(AuthnThrottle)).attempt([ip], 'login', ctx);
      if (!gate.allowed) return tooManyRequests('too many passkey challenges, try again later', gate.retryAfterSeconds);
    }
    try {
      const ceremony = await passkeys.challenge(ctx);
      this.storeFullLogged = false;
      return ceremonyAnswer(ceremony);
    } catch (err) {
      if (!(err instanceof PasskeyChallengesFull)) throw err;
      if (!this.storeFullLogged) {
        this.storeFullLogged = true;
        this._log.warn('passkey challenge store is full (authn.webauthn.challenges.maxRows); anonymous challenges are refused until rows expire');
      }
      return new ServiceUnavailableResponse({ error: 'challenge_store_full', message: 'try again later' }, { Headers: [NO_STORE, { Name: 'Retry-After', Value: '30' }] });
    }
  }

  /**
   * Passkey login
   * Body `{ challengeId, response }`: a login challenge and the browser's AuthenticationResponseJSON. Logs in as POST
   * /auth/login does: ends a session the caller already holds, sets the session cookie and answers the principal
   * summary with the login extensions. Any failure: 401 with the login failure body, plus Retry-After when throttled.
   * @security []
   */
  @Post('auth/passkeys/login')
  @OnInvalidInput(failedLogin)
  public async login(@Body({ required: true }) body: AuthnPasskeyLoginBody, @ClientContext() client: AuthnClientContext) {
    return completeLogin(this.Container, this.Sessions, this._cfg, client, { kind: 'webauthn', challengeId: body.challengeId, response: body.response });
  }

  /**
   * Passkey registration options
   * Body `{ reauthPassword? }`. Answers `{ challengeId, options }` for navigator.credentials.create(): a discoverable
   * credential bound to the caller, the caller's passkeys excluded.
   * @security cookieAuth
   */
  @Post('user/passkeys/options')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  @OnInvalidInput(byField({ reauthPassword: uniformFailure }, unknownField))
  public async options(@Body({ sensitive: ['reauthPassword'] }) body: AuthnReauthPasswordBody, @ClientContext() client: AuthnClientContext) {
    const session = keyManager(client);
    const fresh = await freshAuthOrAnswer(this.Container, client, (body as AuthnReauthPasswordBody | null)?.reauthPassword);
    if ('answer' in fresh) return fresh.answer;
    return ceremonyAnswer(await (await this.passkeys()).registrationOptions(session.identity, contextOf(client, 'request', session.handle)));
  }

  /**
   * Register a passkey
   * Body `{ challengeId, response, name?, reauthPassword? }`: a challenge from POST /user/passkeys/options and the
   * browser's RegistrationResponseJSON. Answers the passkey `{ id, name, transports, createdAt, lastUsedAt }`. 400
   * `invalid_response` (also a used, expired or foreign challenge), `invalid_name` or `invalid_field`; 409
   * `passkey_taken`. The body is checked before fresh auth.
   * @security cookieAuth
   */
  @Post('user/passkeys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  @OnInvalidInput(byField({ reauthPassword: uniformFailure, challengeId: invalidResponse, response: invalidResponse, name: invalidName }, unknownField))
  public async register(@Body({ required: true, sensitive: ['reauthPassword'] }) body: AuthnPasskeyRegisterBody, @ClientContext() client: AuthnClientContext) {
    const session = keyManager(client);
    const fresh = await freshAuthOrAnswer(this.Container, client, body.reauthPassword);
    if ('answer' in fresh) return fresh.answer;
    const { challengeId, response, name } = body;
    const result = await (await this.passkeys()).register(session.identity, { challengeId, response, ...(name !== undefined ? { name } : {}) }, contextOf(client, 'request', session.handle));
    if (!result.ok) {
      if (result.code === 'duplicate') return new Conflict({ error: 'passkey_taken', message: 'this passkey is already registered' }, { Headers: [NO_STORE] });
      return badRequest('invalid_response', 'the registration does not verify against a registration challenge of this user');
    }
    return new Ok(passkeyEntry(result.passkey), { Headers: [NO_STORE] });
  }

  /**
   * List own passkeys
   * @security cookieAuth
   */
  @Get('user/passkeys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async list(@ClientContext() client: AuthnClientContext) {
    const session = keyManager(client);
    return new Ok((await (await this.passkeys()).list(session.identity)).map(passkeyEntry), { Headers: [NO_STORE] });
  }

  /**
   * Delete an own passkey
   * 404 `passkey_not_found` for any id that is not a passkey of the caller, whoever holds it.
   * @security cookieAuth
   */
  @Del('user/passkeys/:id')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  @OnInvalidInput(passkeyNotFound)
  public async remove(@Param(PASSKEY_ID_PARAM) id: string, @ClientContext() client: AuthnClientContext) {
    const session = keyManager(client);
    const removed = await (await this.passkeys()).remove(session.identity, id, contextOf(client, 'request', session.handle));
    if (!removed) return passkeyNotFound();
    return new Ok(null, { Headers: [NO_STORE] });
  }

  protected async passkeys(): Promise<PasskeyService> {
    return await this.Container.resolve(PasskeyService);
  }
}
