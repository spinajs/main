import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, Ok, Param, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { TokenService } from '@spinajs/authn/contracts';

import { isAuthnFailed, refused } from '../../policies/v3/errors.js';
import { TOKEN_ID_CAP, badRequest, invalidExpiry, takeReauthPassword, tokenEntry, tokenNotFound, tokenRequestOf } from '../../token/fields.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, assertFreshAuth } from '../index.js';
import { NO_STORE, authnFailureResponse } from '../responses.js';
import { boundedString, contextOf } from '../routes.js';
import type { Restored } from '../routes.js';

/**
 * The owner's API tokens over the TokenService contract (design §22.9, §22.11; A13, A14, SR-08). Off (404) while no
 * TokenService is registered. Every route acts on the identity of the caller's own session: a token or key caller gets
 * 403 `session_required` (no credential mints or manages credentials), an impersonation 403 `impersonating` (a token
 * minted there would outlive it), an anonymous caller or a pending session 401. Every answer carries no-store.
 *
 * One token on the wire, in the list and as `Token` of the create answer, keeps the names a 2.x client reads:
 * `{ Uuid, Name, Kind, Roles, Profile, Scope, CreatedAt, ExpiresAt, LastUsedAt, LastUsedIp, Expired }`. Instants are
 * ISO 8601 to the second, absent values null, `Roles` always a list. Never the plaintext or its hash.
 * @tags AccessTokens
 */
@BasePath('user')
@Policy(TokenServiceRegistered)
export class AuthnTokensController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * List own tokens
   * A bare list of the caller's live and expired tokens (`Expired` tells them apart); revoked ones are left out.
   * @security cookieAuth
   */
  @Get('tokens')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async list(@Req() req: Request) {
    const session = activeSession(req);
    const records = await (await this.service()).list(session.identity);
    const now = new Date();
    return new Ok(
      records.map((r) => tokenEntry(r, now)),
      { Headers: [NO_STORE] },
    );
  }

  /**
   * Create a token
   * Body `{ name, expiresAt, roles?, profile?, kind?, scope?, reauthPassword? }`. Needs fresh auth: a login within
   * authn.freshAuth.maxAgeSeconds or the account password in `reauthPassword`, verified for this request only. Answers
   * `{ Token, Plaintext }`; the plaintext is shown here once and never again. `expiresAt` is mandatory, at most
   * authn.token.maxTtlDays ahead (an agent token authn.token.agentMaxTtlMinutes). 400 `invalid_name`,
   * `invalid_expiry`, `invalid_kind`, `invalid_roles`, `invalid_profile`, or `invalid_scope` (also a role the owner
   * does not hold, a profile the profile policy does not offer, or a scope that does not fit the kind); 403
   * `fresh_auth_required` for a stale session without the password; a wrong or throttled password the login failure
   * body without Retry-After.
   * @security cookieAuth
   */
  @Post('tokens')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async create(@Req() req: Request) {
    const session = activeSession(req);
    const password = takeReauthPassword(req);
    try {
      // In the handler, not as a FreshAuth policy: http runs every policy of a route at once, so the policy would verify
      // a password while the gate answers 404.
      await assertFreshAuth(this.Container, req, undefined, password);
    } catch (err) {
      // The thrown error's body carries a stack outside production; login's answer never does.
      if (isAuthnFailed(err)) return authnFailureResponse();
      throw err;
    }
    const parsed = tokenRequestOf(req);
    if ('answer' in parsed) return parsed.answer;

    const result = await (await this.service()).create(session.identity, parsed.opts, contextOf(req, 'request', session.handle));
    if (!result.ok) {
      return result.code === 'invalid_expiry' ? invalidExpiry() : badRequest('invalid_scope', 'the roles, profile or scope are not allowed for this token');
    }
    return new Ok({ Token: tokenEntry(result.record, new Date()), Plaintext: result.plaintext }, { Headers: [NO_STORE] });
  }

  /**
   * Revoke an own token
   * The token stops working on its next request. 404 `token_not_found` for any id that is not a live token of the
   * caller, whoever owns it.
   * @security cookieAuth
   */
  @Del('tokens/:uuid')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async revoke(@Req() req: Request, @Param() uuid: string) {
    const session = activeSession(req);
    const id = boundedString(uuid, TOKEN_ID_CAP);
    const revoked = id !== null && (await (await this.service()).revoke(session.identity, id, contextOf(req, 'request', session.handle)));
    if (!revoked) return tokenNotFound();
    return new Ok(null, { Headers: [NO_STORE] });
  }

  protected async service(): Promise<TokenService> {
    return await this.Container.resolve(TokenService);
  }
}

function activeSession(req: Request): Restored {
  const session = req.storage.AuthnSession;
  if (session?.handle.state !== 'active') throw refused('session_required', 'this route needs a session');
  return session;
}
