import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Del, Get, Ok, Param, Patch, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { TokenService } from '@spinajs/authn/contracts';

import { freshAuthOrAnswer, takeReauthPassword } from '../../policies/v3/fresh-auth.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { TOKEN_ID_CAP, invalidExpiry, rotateRequestOf, tokenEntry, tokenNotFound, tokenRequestOf, tokenUpdateOf } from '../../token/fields.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { NO_STORE, badRequest } from '../responses.js';
import { boundedString, contextOf } from '../routes.js';

/**
 * The owner's API tokens over the TokenService contract (design §22.9, §22.11; A13, A14, SR-08). Off (404) while no
 * TokenService is registered. Every route acts on the identity of the caller's own session: a token or key caller gets
 * 403 `session_required` (no credential mints or manages credentials), an impersonation 403 `impersonating` (a token
 * minted there would outlive it), an anonymous caller or a pending session 401. Every answer carries no-store.
 *
 * One token on the wire, in the list and as `Token` of the create, rotate and update answers:
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
    const session = activeSessionOf(req);
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
    const session = activeSessionOf(req);
    const fresh = await freshAuthOrAnswer(this.Container, req, takeReauthPassword(req));
    if ('answer' in fresh) return fresh.answer;
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
    const session = activeSessionOf(req);
    const id = boundedString(uuid, TOKEN_ID_CAP);
    const revoked = id !== null && (await (await this.service()).revoke(session.identity, id, contextOf(req, 'request', session.handle)));
    if (!revoked) return tokenNotFound();
    return new Ok(null, { Headers: [NO_STORE] });
  }

  /**
   * Rotate an own token
   * Replaces the secret of a live token; the id, name, roles and expiry stay. Needs fresh auth like the create route.
   * Body `{ graceSeconds?, reauthPassword? }`: the old secret works for `graceSeconds` more (0 to 604800, default 0).
   * Answers `{ Token, Plaintext }`; the new plaintext is shown here once. 400 `invalid_grace`; 404 `token_not_found` for any id
   * that is not a live token of the caller.
   * @security cookieAuth
   */
  @Post('tokens/:uuid/rotate')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async rotate(@Req() req: Request, @Param() uuid: string) {
    const session = activeSessionOf(req);
    const fresh = await freshAuthOrAnswer(this.Container, req, takeReauthPassword(req));
    if ('answer' in fresh) return fresh.answer;
    const parsed = rotateRequestOf(req);
    if ('answer' in parsed) return parsed.answer;
    const id = boundedString(uuid, TOKEN_ID_CAP);
    if (id === null) return tokenNotFound();

    const result = await (await this.service()).rotate(session.identity, id, contextOf(req, 'request', session.handle), parsed.opts);
    if (!result.ok) return tokenNotFound();
    return new Ok({ Token: tokenEntry(result.token, new Date()), Plaintext: result.plaintext }, { Headers: [NO_STORE] });
  }

  /**
   * Narrow an own token
   * Body `{ name?, roles?, expiresAt? }`. Only narrows: roles must be a subset of the token's (or of the owner's, for a token
   * without roles) and expiresAt not later than the current one. No fresh auth. 400 `invalid_name`, `invalid_roles`,
   * `invalid_expiry`, `invalid_scope` or `invalid_field` (any other key); 404 `token_not_found`.
   * @security cookieAuth
   */
  @Patch('tokens/:uuid')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async update(@Req() req: Request, @Param() uuid: string) {
    const session = activeSessionOf(req);
    const parsed = tokenUpdateOf(req);
    if ('answer' in parsed) return parsed.answer;
    const id = boundedString(uuid, TOKEN_ID_CAP);
    if (id === null) return tokenNotFound();

    const result = await (await this.service()).update(session.identity, id, parsed.change, contextOf(req, 'request', session.handle));
    if (result.ok) return new Ok({ Token: tokenEntry(result.token, new Date()) }, { Headers: [NO_STORE] });
    if (result.reason === 'not_found') return tokenNotFound();
    return result.reason === 'invalid_expiry' ? invalidExpiry() : badRequest('invalid_scope', 'the roles are not allowed for this token');
  }

  protected async service(): Promise<TokenService> {
    // Per call: apps that list no token strategy register no TokenService.
    return await this.Container.resolve(TokenService);
  }
}
