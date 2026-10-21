import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { TokenServiceRegistered } from '../../token/gate.js';

/**
 * Self-revocation of a token by its plaintext (RFC 7009 style). Off (404) while no TokenService is registered.
 * @tags AccessTokens
 */
@BasePath('/')
@Policy(TokenServiceRegistered)
export class AuthnTokenRevocationController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Revoke a token by its plaintext
   * @security []
   */
  @Post('auth/tokens/revoke')
  public async revoke(@Req() _req: Request): Promise<never> {
    throw new Error('not implemented: AuthnTokenRevocationController.revoke');
  }
}
