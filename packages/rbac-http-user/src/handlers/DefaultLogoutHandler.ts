import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { SessionProvider, hashSessionId } from '@spinajs/rbac';
import { Log, Logger } from '@spinajs/log';
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

  @Logger('rbac-session')
  protected Log!: Log;

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

    this.Log.info(`Session destroyed by logout`, {
      Session: hashSessionId(context.Ssid),
      User: context.User?.Uuid,
    });

    return {
      Body: null,
      Cookies: [this.SessionCookies.clear()],
      Headers: [
        // Drop everything this origin left in the browser, not just the cookie:
        // a cached authenticated page is still readable after logout on a
        // shared machine, and `max-age=0` on the cookie does nothing about it.
        { Name: 'Clear-Site-Data', Value: '"cache", "cookies", "storage"' },
        { Name: 'Cache-Control', Value: 'no-store' },
      ],
    };
  }
}
