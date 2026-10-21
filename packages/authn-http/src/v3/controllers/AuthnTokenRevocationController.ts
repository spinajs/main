import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, Ok, Policy, Post } from '@spinajs/http';
import { TokenService } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnTokenRevokeBody } from '../../dto/tokens.js';
import { IpThrottle } from '../../middleware/ip-throttle.js';
import { tooManyRequests } from '../../password/fields.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { OnInvalidInput } from '../../validation/answers.js';
import type { AuthnClientContext } from '../client.js';
import { NO_STORE } from '../responses.js';
import { contextOf } from '../routes.js';

const revoked = (): Ok => new Ok({}, { Headers: [NO_STORE] });

/**
 * Self-revocation of a token by its plaintext (RFC 7009 style), for the holder of a leaked secret. Off (404) while no
 * TokenService is registered. Needs no session: the secret in the body is the whole authorisation. A browser request is
 * origin-checked like any other; a server or CLI sending no Origin is not.
 * @tags AccessTokens
 */
@BasePath('/')
@Policy(TokenServiceRegistered)
export class AuthnTokenRevocationController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Revoke a token by its plaintext
   * Body `{ token }`, as JSON or a form. Answers `200 {}` whether or not a token was revoked (unknown, malformed,
   * already revoked, or a previous secret whose grace has ended), so the answer tells nothing about any token. Every
   * request counts in the `reset` throttle flow keyed on the client ip, shared with the password reset routes, before
   * its body is read; a refused one answers 429 with Retry-After and revokes nothing.
   * @security []
   */
  @Post('auth/tokens/revoke')
  @IpThrottle('reset', (retryAfter) => tooManyRequests('too many revocation requests, try again later', retryAfter), 'count')
  @OnInvalidInput(revoked)
  public async revoke(@Body({ required: true }) body: AuthnTokenRevokeBody, @ClientContext() client: AuthnClientContext) {
    // Per call: apps that list no token strategy register no TokenService.
    await (await this.Container.resolve(TokenService)).revokeByPlaintext(body.token, contextOf(client, 'request'));
    return revoked();
  }
}
