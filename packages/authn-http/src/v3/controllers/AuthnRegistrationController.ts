import { BaseController, BasePath, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { IdentityRegistrarRegistered } from '../index.js';

/**
 * Self-service registration over the IdentityRegistrar contract (FEAT-4, A35). Off (404) while none is registered.
 * @tags Authentication
 */
@BasePath('/')
@Policy(IdentityRegistrarRegistered)
export class AuthnRegistrationController extends BaseController {
  /**
   * Register
   * Body `{ login, email, password }`. Always 202 `{ status: 'accepted' }`, whether the account is new or the address is taken.
   * @security []
   */
  @Post('auth/register')
  public register(@Req() _req: Request) {
    return Promise.reject(new Error('not implemented: AuthnRegistrationController.register'));
  }
}
