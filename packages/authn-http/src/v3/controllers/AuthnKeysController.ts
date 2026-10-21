import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, Ok, Param, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { KeyRegistry, SessionIssuer } from '@spinajs/authn/contracts';
import type { KeyChallengeResult } from '@spinajs/authn/contracts';

import { challengeAnswer, challengeRequestOf, challengeThrottled, keyEntry, keyLoginCredentialsOf, keyManager, keyNotFound, keyRequestOf, kidOf, registerRefusal } from '../../keys/fields.js';
import { KeyRoutesOn } from '../../keys/gate.js';
import { freshAuthOrAnswer, takeReauthPassword } from '../../policies/v3/fresh-auth.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE } from '../responses.js';
import { completeLogin, contextOf } from '../routes.js';
import { clientOf } from '../client.js';

/**
 * Public keys over the KeyRegistry contract (design §22.10, §22.11; A02, A13, A17). Off (404) while no KeyRegistry is
 * registered or authn.keys names no audience (`KeyRoutesOn`). The `/user/keys` routes act on the keys of the caller's
 * own session: a token or key caller gets 403 `session_required` (no credential manages keys), an impersonation 403
 * `impersonating`, an anonymous caller or a pending session 401. Every answer carries no-store.
 *
 * Clients sign challenges as authn-keys documents: the UTF-8 bytes of `spinajs-key-<purpose>:<nonce>:<audience>`, the
 * raw signature as base64url, the challenge named by its `id` unchanged. One key on the wire: `{ kid, name, alg, jwk,
 * thumbprint, scope, createdAt, expiresAt, lastUsedAt, revokedAt, revoked, expired }`, instants ISO 8601 to the second,
 * absent values null, the public JWK members only.
 * @tags Keys
 */
@BasePath('/')
@Policy(KeyRoutesOn)
export class AuthnKeysController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  /**
   * List own keys
   * Every key of the caller, revoked and expired ones included and marked.
   * @returns {AuthnKeyEntry[]} The own keys
   * @security cookieAuth
   */
  @Get('user/keys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async list(@Req() req: Request) {
    const session = keyManager(clientOf(req));
    const records = await (await this.registry()).list(session.identity);
    const now = new Date();
    return new Ok(
      records.map((r) => keyEntry(r, now)),
      { Headers: [NO_STORE] },
    );
  }

  /**
   * Register a key
   * Body `{ jwk, proof: { challengeId, signature }, kid?, name?, expiresAt?, reauthPassword? }`: an Ed25519 or P-256
   * public JWK and its signature over a register challenge this user asked for (POST /auth/keys/challenge). Needs fresh
   * auth: a login within authn.freshAuth.maxAgeSeconds or the account password in `reauthPassword`, verified for this
   * request only. Answers the key. 400 `invalid_key`, `invalid_kid`, `invalid_name`, `invalid_expiry`, `invalid_scope`
   * or `invalid_proof` (also a used, expired or foreign challenge); 409 `key_taken` when the kid or the key is
   * registered already; 403 `fresh_auth_required` for a stale session without the password; a wrong or throttled
   * password the login failure body without Retry-After.
   * @body {AuthnKeyRegisterBody} The public key, its proof, and the password for a stale session
   * @returns {AuthnKeyEntry} The registered key
   * @response 400 {AuthnError} invalid_key, invalid_kid, invalid_name, invalid_expiry, invalid_scope or invalid_proof
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} fresh_auth_required
   * @response 409 {AuthnError} key_taken
   * @security cookieAuth
   */
  @Post('user/keys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async register(@Req() req: Request) {
    const session = keyManager(clientOf(req));
    const fresh = await freshAuthOrAnswer(this.Container, clientOf(req), takeReauthPassword(req));
    if ('answer' in fresh) return fresh.answer;
    const parsed = keyRequestOf(req, new Date());
    if ('answer' in parsed) return parsed.answer;
    const result = await (await this.registry()).register({ ...parsed.key, owner: { type: 'user', id: session.identity.id } }, contextOf(clientOf(req), 'request', session.handle));
    if (!result.ok) return registerRefusal(result.code);
    return new Ok(keyEntry(result.key, new Date()), { Headers: [NO_STORE] });
  }

  /**
   * Revoke an own key
   * The key fails on its next request. 404 `key_not_found` for any kid that is not a key of the caller, whoever owns
   * it; revoking a revoked key of the caller changes nothing.
   * @response 404 {AuthnError} key_not_found
   * @security cookieAuth
   */
  @Del('user/keys/:kid')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async revoke(@Req() req: Request, @Param() kid: string) {
    const session = keyManager(clientOf(req));
    const id = kidOf(kid);
    const revoked = id !== null && (await (await this.registry()).revoke(session.identity, id, contextOf(clientOf(req), 'request', session.handle)));
    if (!revoked) return keyNotFound();
    return new Ok(null, { Headers: [NO_STORE] });
  }

  /**
   * Key challenge
   * Body `{ purpose: 'login', kid }` (anonymous) or `{ purpose: 'register' }` (the caller's own full session, the
   * challenge bound to its user). Answers `{ id, nonce, expiresAt }`. A login challenge for an unknown kid looks the
   * same as one for a known kid (A02); login challenges count against the client ip, and a throttled one answers 429
   * with Retry-After. Register challenges count against nothing here: each throttle flow (login, mfa, reset, reauth)
   * is a budget of the owner's own, which a burst of challenges would spend; http.throttle caps the route per ip.
   * 400 `invalid_purpose`, `invalid_kid`.
   * @body {AuthnKeyChallengeBody} The purpose, and the key of a login challenge
   * @returns {AuthnKeyChallenge} The challenge to sign
   * @response 400 {AuthnError} invalid_purpose or invalid_kid
   * @security []
   */
  @Post('auth/keys/challenge')
  public async challenge(@Req() req: Request) {
    const parsed = challengeRequestOf(req);
    if ('answer' in parsed) return parsed.answer;
    const registry = await this.registry();
    let result: KeyChallengeResult;
    if (parsed.purpose === 'register') {
      const session = keyManager(clientOf(req));
      result = await registry.challenge({ purpose: 'register', owner: { type: 'user', id: session.identity.id } }, contextOf(clientOf(req), 'request', session.handle));
    } else {
      result = await registry.challenge({ purpose: 'login', kid: parsed.kid }, contextOf(clientOf(req), 'login'));
    }
    if (!result.ok) return challengeThrottled(result.retryAfterSeconds);
    return challengeAnswer(result.challenge);
  }

  /**
   * Key login
   * Body `{ keyId, challengeId, signature }`: the key's signature over a login challenge for it. Logs in as POST
   * /auth/login does: ends a session the caller already holds, sets the session cookie and answers the principal
   * summary with the login extensions. Key logins ask for no MFA step under the default MFA policy (a key challenge
   * proves possession); a policy that asks for one gets 200 `{ MfaRequired: [steps] }` with the pending session cookie.
   * Any failure: 401 with the login failure body, plus Retry-After when throttled.
   * @body {AuthnKeyLoginBody} The signature over a login challenge
   * @returns {AuthnLoginAnswer} The principal summary, or the pending answer when MFA is required
   * @response 401 {AuthnFailure} The login failed (Retry-After when throttled)
   * @security []
   */
  @Post('auth/keys/login')
  public async login(@Req() req: Request) {
    return completeLogin(this.Container, this.Sessions, this._cfg, clientOf(req), keyLoginCredentialsOf(req));
  }

  protected async registry(): Promise<KeyRegistry> {
    // Per call: apps that list no key strategy register no KeyRegistry.
    return await this.Container.resolve(KeyRegistry);
  }
}
