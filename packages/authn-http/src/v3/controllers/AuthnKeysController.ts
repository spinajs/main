import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, Ok, Param, Policy, Post, Req } from '@spinajs/http';
import type { ICookie, Request } from '@spinajs/http';
import { AuthnService, KeyRegistry, SessionIssuer } from '@spinajs/authn/contracts';
import type { KeyChallengeResult } from '@spinajs/authn/contracts';

import { challengeAnswer, challengeRequestOf, challengeThrottled, keyEntry, keyLoginCredentialsOf, keyManager, keyNotFound, keyRequestOf, kidOf, registerRefusal } from '../../keys/fields.js';
import { KeyRoutesOn } from '../../keys/gate.js';
import { isAuthnFailed } from '../../policies/v3/errors.js';
import { takeReauthPassword } from '../../token/fields.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, assertFreshAuth } from '../index.js';
import { NO_STORE, authnClearedSessionCookie, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, auditEnded, contextOf, stampClient } from '../routes.js';

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

  /**
   * List own keys
   * Every key of the caller, revoked and expired ones included and marked.
   * @security cookieAuth
   */
  @Get('user/keys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async list(@Req() req: Request) {
    const session = keyManager(req);
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
   * @security cookieAuth
   */
  @Post('user/keys')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async register(@Req() req: Request) {
    const session = keyManager(req);
    const password = takeReauthPassword(req);
    try {
      // In the handler, not as a FreshAuth policy: http runs every policy of a route at once, so the policy would verify
      // a password while the gate answers 404.
      await assertFreshAuth(this.Container, req, undefined, password);
    } catch (err) {
      if (isAuthnFailed(err)) return authnFailureResponse();
      throw err;
    }
    const parsed = keyRequestOf(req, new Date());
    if ('answer' in parsed) return parsed.answer;
    const result = await (await this.registry()).register({ ...parsed.key, owner: { type: 'user', id: session.identity.id } }, contextOf(req, 'request', session.handle));
    if (!result.ok) return registerRefusal(result.code);
    return new Ok(keyEntry(result.key, new Date()), { Headers: [NO_STORE] });
  }

  /**
   * Revoke an own key
   * The key fails on its next request. 404 `key_not_found` for any kid that is not a key of the caller, whoever owns
   * it; revoking a revoked key of the caller changes nothing.
   * @security cookieAuth
   */
  @Del('user/keys/:kid')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async revoke(@Req() req: Request, @Param() kid: string) {
    const session = keyManager(req);
    const id = kidOf(kid);
    const revoked = id !== null && (await (await this.registry()).revoke(session.identity, id, contextOf(req, 'request', session.handle)));
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
   * @security []
   */
  @Post('auth/keys/challenge')
  public async challenge(@Req() req: Request) {
    const parsed = challengeRequestOf(req);
    if ('answer' in parsed) return parsed.answer;
    const registry = await this.registry();
    let result: KeyChallengeResult;
    if (parsed.purpose === 'register') {
      const session = keyManager(req);
      result = await registry.challenge({ purpose: 'register', owner: { type: 'user', id: session.identity.id } }, contextOf(req, 'request', session.handle));
    } else {
      result = await registry.challenge({ purpose: 'login', kid: parsed.kid }, contextOf(req, 'login'));
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
   * @security []
   */
  @Post('auth/keys/login')
  public async login(@Req() req: Request) {
    const sessions = await this.Container.resolve(SessionIssuer);
    const held = req.storage.AuthnSession;
    if (held) {
      await sessions.revoke(held.handle);
      await auditEnded(this.Container, req, held, 'session.revoke', 'login');
    }
    const cleared: ICookie[] = held ? [authnClearedSessionCookie(this._cfg)] : [];

    const credentials = keyLoginCredentialsOf(req);
    if (credentials === null) return authnFailureResponse(undefined, cleared);

    const authn = await this.Container.resolve(AuthnService);
    const result = await authn.authenticate(credentials, contextOf(req, 'login'));
    if (result.status === 'failure') return authnFailureResponse(result.reason === 'throttled' ? result.retryAfterSeconds : undefined, cleared);
    if (result.status === 'mfa_required') {
      await stampClient(sessions, result.pending, req);
      return new Ok({ MfaRequired: [...result.steps] }, { Coockies: [authnSessionCookie(this._cfg, result.pending)], Headers: [NO_STORE] });
    }
    if (!result.session) return authnFailureResponse(undefined, cleared);
    await stampClient(sessions, result.session, req);
    const principal = await authn.principalOf(result);
    return new Ok(await answerFor(this.Container, 'login', principal), { Coockies: [authnSessionCookie(this._cfg, result.session)], Headers: [NO_STORE] });
  }

  protected async registry(): Promise<KeyRegistry> {
    return await this.Container.resolve(KeyRegistry);
  }
}
