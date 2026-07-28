import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { SessionProvider } from '@spinajs/rbac';
import { LogoutHandler, ILogoutContext, ILogoutResult } from '../logout.js';
import { SessionCookieFactory } from '../services/SessionCookies.js';

/**
 * Default logout handler: deletes the session and clears the ssid cookie.
 * Runs last (priority 999) so any earlier handler can short-circuit (e.g.
 * the impersonation revert handler) before the session is destroyed.
 */
@Injectable(LogoutHandler)
export class DefaultLogoutHandler extends LogoutHandler {
  public Priority = 999;

  @AutoinjectService('rbac.session')
  protected SessionProvider!: SessionProvider;

  @Autoinject(SessionCookieFactory)
  protected SessionCookies!: SessionCookieFactory;

  public async handle(context: ILogoutContext): Promise<ILogoutResult | null> {
    if (!context.Ssid) {
      // Nothing to delete; still return a result so the chain stops.
      return { Body: null };
    }

    await this.SessionProvider.delete(context.Ssid);

    return {
      Body: null,
      Cookies: [this.SessionCookies.clear()],
    };
  }
}
