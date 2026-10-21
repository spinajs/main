import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';

/**
 * Fresh authentication that lasts (A13): the password re-authenticates the active session, which then moves to a new
 * id with `authenticatedAt` set to now, so FreshAuth routes pass without `reauthPassword` for
 * authn.freshAuth.maxAgeSeconds. The inline `reauthPassword` of a FreshAuth route still counts for that request only.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnReauthController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  /**
   * Re-authenticate the session
   * Body `{ password }`. Success: the session cookie of the new id and the principal summary. 401 with the login failure body for a wrong or throttled password (no Retry-After); 403 for a pending session or an impersonation.
   * @security cookieAuth
   */
  @Post('reauth')
  public async reauth(@Req() _req: Request): Promise<never> {
    throw new Error('not implemented: AuthnReauthController.reauth');
  }
}
