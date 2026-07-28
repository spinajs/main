import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import type { ISession } from '@spinajs/rbac';
import { sessionCookieMaxAge } from '@spinajs/rbac';

/** Cookie descriptor accepted by the http `Coockies` response option. */
export interface ISessionCookie {
  Name: string;
  Value: string;
  Options: Record<string, unknown>;
}

/** Name of the session cookie. Shared so no call site spells it by hand. */
export const SESSION_COOKIE_NAME = 'ssid';

/**
 * Builds the `ssid` cookie.
 *
 * Every place that opens, rotates, or clears a session used to inline the same
 * literal — login, 2FA verify, active-role switch and logout each carried their
 * own copy, and each had to remember `signed`, `httpOnly`, the configured
 * overrides, and to derive maxAge from the session's real expiration. A drift in
 * any one of them silently produces a cookie the next request cannot restore.
 */
@Injectable()
export class SessionCookieFactory {
  @Config('rbac.session.cookie', {})
  protected SessionCookieConfig: Record<string, unknown>;

  /**
   * Cookie carrying an active session. `maxAge` tracks the session's real
   * expiration rather than a fixed constant, so sliding and absolute
   * expiration strategies both produce a cookie that outlives exactly as long
   * as the session behind it.
   */
  public issue(session: ISession): ISessionCookie {
    return {
      Name: SESSION_COOKIE_NAME,
      Value: session.SessionId,
      Options: {
        signed: true,
        httpOnly: true,
        maxAge: sessionCookieMaxAge(session),
        ...this.SessionCookieConfig,
      },
    };
  }

  /** Same cookie, expired — clears the session client-side on logout. */
  public clear(): ISessionCookie {
    return {
      Name: SESSION_COOKIE_NAME,
      Value: '',
      Options: {
        httpOnly: true,
        maxAge: 0,
        ...this.SessionCookieConfig,
      },
    };
  }
}
