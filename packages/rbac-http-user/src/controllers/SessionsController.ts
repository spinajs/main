import { BaseController, BasePath, Del, Get, NotFound, Ok, Param, Policy } from '@spinajs/http';
import { SessionProvider, User as UserModel, hashSessionId } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { AutoinjectService } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthorizedPolicy, Permission, Resource, SessionId as SessionIdArg, User } from '@spinajs/rbac-http';

/** One live session of the calling user. */
export interface IUserSessionEntry {
  /**
   * Opaque, stable handle for the session. Deliberately NOT the session id:
   * listing your own sessions must not hand out working credentials for them,
   * because the response ( and anything that caches or logs it ) would then be
   * as good as the cookies themselves.
   */
  Handle: string;

  /** ISO instant the session was opened */
  Created: string;

  /** ISO instant the session expires, or null when it never does */
  Expires: string | null;

  /** True for the session making this request */
  Current: boolean;
}

/**
 * Active sessions of the calling user — "where am I logged in", plus the means
 * to end any of them.
 *
 * OWASP asks for exactly this: the user should be able to see concurrent
 * sessions and terminate them remotely, which is how a person who suspects a
 * stolen cookie gets rid of it without an administrator.
 *
 * @tags Sessions
 */
@BasePath('user')
@Resource('user')
@Policy(AuthorizedPolicy)
export class SessionsController extends BaseController {
  @Logger('rbac-session')
  protected Log: Log;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  /**
   * List own sessions
   * Returns every live session of the authenticated user, newest first, with the
   * one making the request flagged.
   * @security cookieAuth
   * @returns {IUserSessionEntry[]} Live sessions of the calling user
   * @response 401 Unauthorized — valid session required
   */
  @Get('sessions')
  @Permission(['readOwn'])
  public async list(@User() user: UserModel, @SessionIdArg() ssid: string): Promise<Ok<IUserSessionEntry[]>> {
    const sessions = await this.SessionProvider.listByUser(user.Id);
    const current = ssid ? hashSessionId(ssid) : null;

    const entries = sessions
      .map((s) => this.toEntry(s, current))
      .sort((a, b) => (a.Created < b.Created ? 1 : -1));

    return new Ok(entries);
  }

  /**
   * Revoke one session
   * Ends the session identified by its handle. Revoking the current session is
   * allowed and logs the caller out.
   * @security cookieAuth
   * @param handle Session handle as returned by `GET /user/sessions`
   * @response 200 Session revoked
   * @response 401 Unauthorized — valid session required
   * @response 404 No such session for this user
   */
  @Del('sessions/:handle')
  @Permission(['updateOwn'])
  public async revoke(@User() user: UserModel, @Param() handle: string): Promise<Ok | NotFound> {
    // Resolved through the user's OWN session list, so a handle belonging to
    // somebody else's session simply is not found here — the route cannot be
    // used to end a stranger's session even if its handle leaks.
    const sessions = await this.SessionProvider.listByUser(user.Id);
    const match = sessions.find((s) => hashSessionId(s.SessionId) === handle);

    if (!match) {
      return new NotFound({ error: { code: 'E_SESSION_NOT_FOUND', message: 'No such session' } });
    }

    await this.SessionProvider.delete(match.SessionId);

    this.Log.info(`Session revoked by its owner`, { Session: handle, User: user.Uuid });

    return new Ok(null, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  /**
   * Revoke every other session
   * Ends all sessions of the user except the one making the request — the
   * "log out everywhere else" action after a suspected compromise.
   * @security cookieAuth
   * @response 200 Other sessions revoked
   * @response 401 Unauthorized — valid session required
   */
  @Del('sessions')
  @Permission(['updateOwn'])
  public async revokeOthers(@User() user: UserModel, @SessionIdArg() ssid: string): Promise<Ok> {
    const sessions = await this.SessionProvider.listByUser(user.Id);

    let revoked = 0;
    for (const session of sessions) {
      if (session.SessionId === ssid) {
        continue;
      }

      await this.SessionProvider.delete(session.SessionId);
      revoked++;
    }

    this.Log.info(`Revoked ${revoked} other session(s)`, { User: user.Uuid });

    return new Ok({ Revoked: revoked }, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  protected toEntry(session: ISession, currentHandle: string | null): IUserSessionEntry {
    const handle = hashSessionId(session.SessionId);

    return {
      Handle: handle,
      Created: session.Creation?.toISO() ?? '',
      Expires: session.Expiration?.toISO() ?? null,
      Current: handle === currentHandle,
    };
  }
}
