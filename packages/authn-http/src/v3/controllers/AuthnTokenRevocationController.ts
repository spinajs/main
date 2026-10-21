import { Config } from '@spinajs/configuration';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthnThrottle, TokenService, ipKey, ipv6PrefixOf } from '@spinajs/authn/contracts';

import { tooManyRequests } from '../../password/fields.js';
import { TokenServiceRegistered } from '../../token/gate.js';
import { NO_STORE } from '../responses.js';
import { bodyField, boundedString, contextOf } from '../routes.js';
import { clientOf } from '../client.js';

/** Well above the length of any minted token. */
const TOKEN_CAP = 1024;

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

  @Config('authn.throttle.ipv6Prefix')
  protected ThrottleIpv6Prefix: unknown;

  /**
   * Revoke a token by its plaintext
   * Body `{ token }`, as JSON or a form. Answers `200 {}` whether or not a token was revoked (unknown, malformed,
   * already revoked, or a previous secret whose grace has ended), so the answer tells nothing about any token. Every
   * request counts in the `reset` throttle flow keyed on the client ip, shared with the password reset routes; a
   * refused one answers 429 with Retry-After and revokes nothing.
   * @security []
   */
  @Post('auth/tokens/revoke')
  public async revoke(@Req() req: Request) {
    const ctx = contextOf(clientOf(req), 'request');
    const throttle = await this.Container.resolve(AuthnThrottle);
    const gate = await throttle.attempt([ipKey(ctx, ipv6PrefixOf(this.ThrottleIpv6Prefix)) ?? { kind: 'ip', value: 'unknown' }], 'reset', ctx);
    if (!gate.allowed) return tooManyRequests('too many revocation requests, try again later', gate.retryAfterSeconds);

    const token = boundedString(bodyField(req, 'token'), TOKEN_CAP);
    if (token !== null) {
      // Per call: apps that list no token strategy register no TokenService.
      await (await this.Container.resolve(TokenService)).revokeByPlaintext(token, ctx);
    }
    return new Ok({}, { Headers: [NO_STORE] });
  }
}
