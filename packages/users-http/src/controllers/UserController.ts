import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { IResponseHeader, Request } from '@spinajs/http';
import { Config } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '@spinajs/authn-http';
import { ACCESS_DOMAIN_KEY } from '@spinajs/users';
import type { User } from '@spinajs/users';

import { CurrentUser } from '../args/current-user.js';
import { ownUser } from '../services/own-user.js';
import { assertTokenRoutesOn, offeredTokenProfiles, offeredTokenRoles } from '../services/token-offer.js';

/** The callers authn-http's `POST /user/tokens` serves: a session, not a token or key, and not an impersonation. */
const TOKEN_CREATORS = [Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy];

const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

const PROFILE_MAX_LENGTH = 128;

function profileOf(req: Request): string | undefined {
  const profile: unknown = req.query?.profile;
  if (profile === undefined) return undefined;
  if (typeof profile !== 'string' || profile === '' || profile.length > PROFILE_MAX_LENGTH) {
    throw new InvalidArgument(`profile must be one role name of 1 to ${PROFILE_MAX_LENGTH} characters`, 'profile');
  }
  return profile;
}

/**
 * The signed-in user's own account.
 * @tags User
 */
@BasePath('user')
export class UserController extends BaseController {
  @Config(ACCESS_DOMAIN_KEY)
  protected AccessDomain: string;

  /**
   * Current user profile
   * The signed-in user's record with its metadata (reserved keys left out), limited to the fields its roles read on
   * it: with users' shipped `user` role, Email and Login.
   * @security cookieAuth
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — not a user principal, or no `user:read` on its own record
   */
  @Get('/')
  @Access('user:read', { resource: ownUser, subject: 'load', fields: 'filter' })
  public async refresh(@CurrentUser() user: User) {
    return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Roles a new token may carry
   * `{ Roles }`: the roles `POST /user/tokens` accepts from the caller (held at any scope), less those a token
   * loses at check time (`authz.token.excludedRoles` and the token role policy). With `profile`, those of a token
   * pinned to that profile; none for a profile the create route refuses.
   * @security cookieAuth
   * @param profile Optional profile the token would be pinned to
   * @response 400 Bad request — `profile` is not one role name
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — not the user in person (`session_required`, `impersonating`), or no `user:read` on its own record
   * @response 404 Not found — no TokenService is registered
   * @response 500 The token role rules or policies cannot be read: nothing is offered
   */
  @Get('tokens/roles')
  @Access('user:read', { resource: ownUser, subject: 'load', also: TOKEN_CREATORS })
  public async tokenRoles(@CurrentPrincipal() caller: Principal, @Req() req: Request) {
    assertTokenRoutesOn();
    const profile = profileOf(req);
    return new Ok({ Roles: await offeredTokenRoles(caller, this.AccessDomain, profile) }, { Headers: [NO_STORE] });
  }

  /**
   * Profiles a new token may be pinned to
   * `{ Profiles }`: those `POST /user/tokens` accepts from the caller (authn-token's TokenProfilePolicy); none
   * while the application offers no profile tokens.
   * @security cookieAuth
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — not the user in person (`session_required`, `impersonating`), or no `user:read` on its own record
   * @response 404 Not found — no TokenService is registered
   * @response 500 The profile policy cannot be read: nothing is offered
   */
  @Get('tokens/profiles')
  @Access('user:read', { resource: ownUser, subject: 'load', also: TOKEN_CREATORS })
  public async tokenProfiles(@CurrentPrincipal() caller: Principal) {
    assertTokenRoutesOn();
    return new Ok({ Profiles: await offeredTokenProfiles(caller) }, { Headers: [NO_STORE] });
  }
}
