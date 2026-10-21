import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PasswordService, SessionIssuer } from '@spinajs/authn/contracts';

import { CodeLoginRegistered } from '../../password/index.js';

/**
 * Login with a code mailed to the account's address, over the optional `requestCode` of the PasswordService and the
 * `email-code` strategy (FEAT-3, A36). Off (404) while the registered PasswordService sends no codes.
 * @tags Authentication
 */
@BasePath('/')
@Policy(CodeLoginRegistered)
export class AuthnCodeLoginController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Autoinject(PasswordService, { optional: true })
  protected Passwords: PasswordService | undefined;

  /**
   * Request a login code
   * @security []
   */
  @Post('auth/code/request')
  public async request(@Req() _req: Request) {
    throw new Error('not implemented: AuthnCodeLoginController.request');
  }

  /**
   * Log in with a code
   * @security []
   */
  @Post('auth/code/login')
  public async login(@Req() _req: Request) {
    throw new Error('not implemented: AuthnCodeLoginController.login');
  }
}
