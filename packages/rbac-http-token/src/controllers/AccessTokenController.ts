import { BadRequestResponse, BaseController, BasePath, Body, Del, Get, NotFound, Ok, Param, Policy, Post, Put } from '@spinajs/http';
import { User as UserModel } from '@spinajs/rbac';
import { Permission, Resource, User } from '@spinajs/rbac-http';
import { ErrorCode } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { AccessToken } from '../models/AccessToken.js';
import { E_CODES, createToken, deleteToken, grantTokenRole, revokeTokenRole } from '../actions.js';
import { CreateTokenDto } from '../dto/create-token-dto.js';
import { NoTokenAuthPolicy } from '../policies/NoTokenAuthPolicy.js';
import { NoImpersonationPolicy } from '../policies/NoImpersonationPolicy.js';

/**
 * Self-service management of own access tokens.
 *
 * SELF-service in the strict sense: the caller must be the account owner,
 * present in person. Two ways of acting *as* somebody are refused outright -
 * an access token ( which must never mint another token ) and an impersonated
 * session ( which must never mint a credential that outlives it ). Every query
 * is additionally constrained by the calling user's id, so a foreign uuid is
 * simply not found.
 *
 * WIRING - the decorator layout below is load bearing. The two guards share ONE
 * `@Policy([...])` group so they are ANDed; splitting them into two `@Policy()`
 * calls would OR them and each would become optional. And do NOT add a class
 * level `@Policy(RbacPolicy)` alongside:
 *
 * `@spinajs/http` combines policies at three levels ( see `createPolicyGate` in
 * `http/src/route-builder.ts` ): AND inside one `@Policy()` group, OR between
 * the groups declared at one scope, AND between the controller scope and the
 * route scope. `@Permission()` already pushes `RbacPolicy` as a group on the
 * ROUTE ( `rbac-http/src/decorators.ts` ), so:
 *
 *   - controller scope holds exactly ONE group,
 *     `[NoTokenAuthPolicy, NoImpersonationPolicy]`. A lone group cannot be ORed
 *     away, so both are a hard requirement of EVERY route on this controller,
 *     including any route added later.
 *   - route scope holds `[RbacPolicy]` from `@Permission`, which demands an
 *     authorized session AND the declared grant.
 *
 * Adding `@Policy(RbacPolicy)` at class level would make the controller scope
 * `[NoTokenAuthPolicy, NoImpersonationPolicy] OR [RbacPolicy]`, and satisfying
 * `RbacPolicy` alone would then discharge the whole scope - both invariants
 * would rest on nothing but RbacPolicy's own session check, which does not look
 * at impersonation at all.
 *
 * @tags AccessTokens
 */
@BasePath('user')
@Resource('user.tokens')
@Policy([NoTokenAuthPolicy, NoImpersonationPolicy])
export class AccessTokenController extends BaseController {
  /**
   * List own access tokens
   * Hashes are never returned - `Token` is `@Hidden()` on the model, so the
   * dehydrated rows carry the uuid, label, roles and timestamps only.
   * @security cookieAuth
   * @response 200 Own tokens
   * @response 401 Unauthorized - valid session required
   * @response 403 Forbidden - access tokens cannot be used on this route
   */
  @Get('tokens')
  @Permission(['readOwn'])
  public async list(@User() user: UserModel): Promise<Ok<unknown>> {
    const tokens = await AccessToken.where('user_id', user.Id);
    return new Ok(tokens.map((t) => this.toWire(t)));
  }

  /**
   * Create an access token
   * The plaintext appears in this response only and cannot be retrieved again.
   * Roles must be a subset of the caller's own roles.
   * @security cookieAuth
   * @response 200 Token created, `Plaintext` returned once
   * @response 400 Requested roles are not held by the caller
   * @response 401 Unauthorized - valid session required
   * @response 403 Forbidden - access tokens cannot be used on this route
   */
  @Post('tokens')
  @Permission(['createOwn'])
  public async create(@User() user: UserModel, @Body() dto: CreateTokenDto): Promise<Ok<unknown> | BadRequestResponse> {
    const expiresAt = dto.ExpiresAt ? DateTime.fromISO(dto.ExpiresAt) : null;

    try {
      const { Token, Plaintext } = await createToken(user, dto.Name, dto.Roles, expiresAt);
      return new Ok({ Token: this.toWire(Token), Plaintext }, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
    } catch (err) {
      return this.roleError(err);
    }
  }

  /**
   * Delete ( revoke ) an own token
   * @security cookieAuth
   * @param uuid Public identifier of the token
   * @response 200 Token deleted
   * @response 401 Unauthorized - valid session required
   * @response 403 Forbidden - access tokens cannot be used on this route
   * @response 404 No such token for this user
   */
  @Del('tokens/:uuid')
  @Permission(['deleteOwn'])
  public async delete(@User() user: UserModel, @Param() uuid: string): Promise<Ok | NotFound> {
    const token = await this.own(user, uuid);
    if (!token) {
      return new NotFound({ error: { code: 'E_TOKEN_NOT_FOUND', message: 'No such token' } });
    }

    await deleteToken(token);
    return new Ok();
  }

  /**
   * Grant a role to an own token
   * The role must be held by the caller - a token can never carry more than its
   * owner does.
   * @security cookieAuth
   * @param uuid Public identifier of the token
   * @param role Role name to grant
   * @response 200 Updated token
   * @response 400 Role is not held by the caller
   * @response 401 Unauthorized - valid session required
   * @response 403 Forbidden - access tokens cannot be used on this route
   * @response 404 No such token for this user
   */
  @Put('tokens/:uuid/roles/:role')
  @Permission(['updateOwn'])
  public async grantRole(@User() user: UserModel, @Param() uuid: string, @Param() role: string): Promise<Ok<unknown> | NotFound | BadRequestResponse> {
    const token = await this.own(user, uuid);
    if (!token) {
      return new NotFound({ error: { code: 'E_TOKEN_NOT_FOUND', message: 'No such token' } });
    }

    try {
      const updated = await grantTokenRole(token, role);
      return new Ok(this.toWire(updated));
    } catch (err) {
      return this.roleError(err);
    }
  }

  /**
   * Revoke a role from an own token
   * A token must keep at least one role; dropping the last one is refused with
   * 400 - deleting the token is the way to revoke it entirely.
   * @security cookieAuth
   * @param uuid Public identifier of the token
   * @param role Role name to revoke
   * @response 200 Updated token
   * @response 400 Cannot revoke the token's last role
   * @response 401 Unauthorized - valid session required
   * @response 403 Forbidden - access tokens cannot be used on this route
   * @response 404 No such token for this user
   */
  @Del('tokens/:uuid/roles/:role')
  @Permission(['updateOwn'])
  public async revokeRole(@User() user: UserModel, @Param() uuid: string, @Param() role: string): Promise<Ok<unknown> | NotFound | BadRequestResponse> {
    const token = await this.own(user, uuid);
    if (!token) {
      return new NotFound({ error: { code: 'E_TOKEN_NOT_FOUND', message: 'No such token' } });
    }

    try {
      const updated = await revokeTokenRole(token, role);
      return new Ok(this.toWire(updated));
    } catch (err) {
      return this.roleError(err);
    }
  }

  /**
   * Resolves a token by uuid WITHIN the caller's own tokens - the ownership
   * boundary of this whole controller.
   */
  protected own(user: UserModel, uuid: string): Promise<AccessToken | undefined> {
    return AccessToken.where({ Uuid: uuid, user_id: user.Id }).first();
  }

  /**
   * Wire shape of one token: the dehydrated row, with `Roles` put back as a
   * real array.
   *
   * `dehydrate()` runs every column through its converter's `toDB` direction,
   * and `@Set()`'s converter joins the list into `"user,admin"` - the storage
   * encoding, not the API contract. Left alone, `Roles` reaches clients as a
   * string that only looks like a list, which no generated client parses back.
   * `@spinajs/rbac-http-user`'s whoami restores `Role` the same way for the same
   * reason. `@Hidden()` columns ( `Token`, `Id`, `user_id` ) are dropped by
   * `dehydrate` itself, so the hash still never leaves here.
   */
  protected toWire(token: AccessToken): Record<string, unknown> {
    return { ...token.toJSON(), Roles: [...token.Roles] };
  }

  /**
   * Turns the actions layer's role refusals into a 400.
   *
   * `ErrorCode` has no entry in the http error map, so an uncaught one leaves as
   * a 500 - and "you asked for a role you do not have" / "a token must keep one
   * role" are the caller's mistakes, not the server's. Anything else is rethrown
   * untouched so a genuine failure still reaches the error handler.
   */
  protected roleError(err: unknown): BadRequestResponse {
    if (err instanceof ErrorCode && err.code === E_CODES.E_TOKEN_ROLE_NOT_ALLOWED) {
      return new BadRequestResponse({ error: { code: 'E_TOKEN_ROLE_NOT_ALLOWED', message: err.message } });
    }

    throw err;
  }
}
