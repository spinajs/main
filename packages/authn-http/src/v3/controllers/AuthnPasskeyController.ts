import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Conflict, Del, Get, NotFound, Ok, Param, Policy, Post, Req } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { AuthnService, PasskeyService, SessionIssuer } from '@spinajs/authn/contracts';
import type { Credentials, PasskeyCeremony, PasskeyEntry } from '@spinajs/authn/contracts';
import { isPlainObject } from '@spinajs/util';

import { keyManager } from '../../keys/fields.js';
import { notFound } from '../../policies/v3/errors.js';
import { serviceRegistered } from '../../policies/v3/groups.js';
import { freshAuthOrAnswer, takeReauthPassword } from '../../policies/v3/fresh-auth.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, badRequest, instant } from '../responses.js';
import { bodyField, boundedString, completeLogin, contextOf } from '../routes.js';

/** Above the challenge ids authn-webauthn draws (22 characters). */
const CHALLENGE_ID_CAP = 64;
/** WebAuthn caps credential ids at 1023 bytes, 1364 characters of base64url. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1364}$/;
const NAME_CAP = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

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

/** `{ challengeId, response }` of a ceremony body, the response an object; null when either is missing. */
function ceremonyBody(req: Request): { challengeId: string; response: Record<string, unknown> } | null {
  const challengeId = boundedString(bodyField(req, 'challengeId'), CHALLENGE_ID_CAP);
  const response = bodyField(req, 'response');
  return challengeId !== null && isPlainObject(response) ? { challengeId, response } : null;
}

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

  /**
   * Passkey challenge
   * Anonymous: assertion options for any discoverable credential. With a pending session, a challenge for the WebAuthn
   * MFA step that allows only that identity's credentials; its answer goes to POST /auth/mfa/verify as the step code.
   * Answers `{ challengeId, options }`.
   * @security []
   */
  @Post('auth/passkeys/challenge')
  public async challenge(@Req() req: Request) {
    const passkeys = await this.passkeys();
    const session = req.storage.AuthnSession;
    if (session?.handle.state === 'pending') return ceremonyAnswer(await passkeys.challenge(contextOf(req, 'login', session.handle), session.identity));
    return ceremonyAnswer(await passkeys.challenge(contextOf(req, 'login')));
  }

  /**
   * Passkey login
   * Body `{ challengeId, response }`: a login challenge and the browser's AuthenticationResponseJSON. Logs in as POST
   * /auth/login does: ends a session the caller already holds, sets the session cookie and answers the principal
   * summary with the login extensions. Any failure: 401 with the login failure body, plus Retry-After when throttled.
   * @security []
   */
  @Post('auth/passkeys/login')
  public async login(@Req() req: Request) {
    const body = ceremonyBody(req);
    const credentials: Credentials | null = body && { kind: 'webauthn', challengeId: body.challengeId, response: body.response };
    return completeLogin(this.Container, this.Sessions, this._cfg, req, credentials);
  }

  /**
   * Passkey registration options
   * Body `{ reauthPassword? }`. Answers `{ challengeId, options }` for navigator.credentials.create(): a discoverable
   * credential bound to the caller, the caller's passkeys excluded.
   * @security cookieAuth
   */
  @Post('user/passkeys/options')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async options(@Req() req: Request) {
    const session = keyManager(req);
    const fresh = await freshAuthOrAnswer(this.Container, req, takeReauthPassword(req));
    if ('answer' in fresh) return fresh.answer;
    return ceremonyAnswer(await (await this.passkeys()).registrationOptions(session.identity, contextOf(req, 'request', session.handle)));
  }

  /**
   * Register a passkey
   * Body `{ challengeId, response, name?, reauthPassword? }`: a challenge from POST /user/passkeys/options and the
   * browser's RegistrationResponseJSON. Answers the passkey `{ id, name, transports, createdAt, lastUsedAt }`. 400
   * `invalid_response` (also a used, expired or foreign challenge) or `invalid_name`; 409 `passkey_taken`.
   * @security cookieAuth
   */
  @Post('user/passkeys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async register(@Req() req: Request) {
    const session = keyManager(req);
    const fresh = await freshAuthOrAnswer(this.Container, req, takeReauthPassword(req));
    if ('answer' in fresh) return fresh.answer;
    const body = ceremonyBody(req);
    if (!body) return badRequest('invalid_response', 'challengeId and response are required');
    const name = bodyField(req, 'name');
    if (name !== undefined && (boundedString(name, NAME_CAP) === null || CONTROL_CHARACTERS.test(name as string))) return badRequest('invalid_name', `name must be 1 to ${NAME_CAP} characters without control characters`);
    const result = await (await this.passkeys()).register(session.identity, { ...body, ...(name !== undefined ? { name: name as string } : {}) }, contextOf(req, 'request', session.handle));
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
  public async list(@Req() req: Request) {
    const session = keyManager(req);
    return new Ok((await (await this.passkeys()).list(session.identity)).map(passkeyEntry), { Headers: [NO_STORE] });
  }

  /**
   * Delete an own passkey
   * 404 `passkey_not_found` for any id that is not a passkey of the caller, whoever holds it.
   * @security cookieAuth
   */
  @Del('user/passkeys/:id')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async remove(@Req() req: Request, @Param() id: string) {
    const session = keyManager(req);
    const removed = typeof id === 'string' && CREDENTIAL_ID.test(id) && (await (await this.passkeys()).remove(session.identity, id, contextOf(req, 'request', session.handle)));
    if (!removed) return passkeyNotFound();
    return new Ok(null, { Headers: [NO_STORE] });
  }

  protected async passkeys(): Promise<PasskeyService> {
    return await this.Container.resolve(PasskeyService);
  }
}
