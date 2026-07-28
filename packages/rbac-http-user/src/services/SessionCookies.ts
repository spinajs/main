import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import type { ISession, ISessionCookieConfig } from '@spinajs/rbac';
import { clearSessionCookie, sessionCookie, sessionCookieName } from '@spinajs/rbac';

/** Cookie descriptor accepted by the http `Coockies` response option. */
export interface ISessionCookie {
  Name: string;
  Value: string;
  Options: Record<string, unknown>;
}

/**
 * Default name of the session cookie. Kept for callers that only need the
 * literal; the ACTIVE name comes from configuration and may carry a `__Host-`
 * prefix, so read {@link SessionCookieFactory.Name} instead of assuming this.
 */
export const SESSION_COOKIE_NAME = 'ssid';

/**
 * Builds the session cookie.
 *
 * Every place that opens, rotates, or clears a session used to inline the same
 * literal — login, 2FA verify, active-role switch and logout each carried their
 * own copy, and each had to remember `signed`, `httpOnly`, the configured
 * overrides, and to derive maxAge from the session's real expiration. A drift in
 * any one of them silently produces a cookie the next request cannot restore.
 *
 * The attributes themselves are decided by `@spinajs/rbac` so the session
 * middleware — which renews the very same cookie on every request, from a
 * package that cannot import this one — produces a byte-identical set.
 */
@Injectable()
export class SessionCookieFactory {
  @Config('rbac.session.cookie', {})
  protected SessionCookieConfig: ISessionCookieConfig;

  /** Configured cookie name, `__Host-` prefix included when enabled. */
  public get Name(): string {
    return sessionCookieName(this.SessionCookieConfig);
  }

  /**
   * Cookie carrying an active session. `maxAge` tracks the session's real
   * expiration rather than a fixed constant, so sliding and absolute
   * expiration strategies both produce a cookie that outlives exactly as long
   * as the session behind it.
   */
  public issue(session: ISession): ISessionCookie {
    return sessionCookie(session, this.SessionCookieConfig);
  }

  /** Same cookie, expired — clears the session client-side on logout. */
  public clear(): ISessionCookie {
    return clearSessionCookie(this.SessionCookieConfig);
  }
}
