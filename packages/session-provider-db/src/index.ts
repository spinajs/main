import { UserSessionData } from './../../rbac/src/interfaces';
import { SessionProvider, Session } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/Session';
import { InsertBehaviour } from '@spinajs/orm';
import { DateTime } from 'luxon';

export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  // tslint:disable-next-line: no-empty
  public async resolveAsync() {}

  public async restoreSession(sessionId: string): Promise<Session> {
    const session = await DbSession.where({
      SessionId: sessionId,
    }).first();

    if (!session) {
      return null;
    }

    if (session.Expiration < DateTime.now()) {
      return null;
    }

    return new Session({
      ...session,
      Creation: session.CreatedAt,
      Data: JSON.parse(session.Data),
    });
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const entry = await DbSession.where('SessionId', sessionId).first();
    if (entry) {
      await entry.destroy();
    }
  }

  public async updateSession(s: UserSessionData): Promise<void> {
    const session = new DbSession({
      ...s,
      Data: JSON.stringify(s.Data),
    });

    await session.insert(InsertBehaviour.InsertOrUpdate);
  }

  public async refreshSession(session: string | UserSessionData): Promise<void> {
    let sInstance: Session = null;

    if (typeof session === 'string') {
      sInstance = await this.restoreSession(session);
    } else {
      sInstance = new Session(session);
    }

    sInstance.extend(this.Configuration.get<number>('acl.session.expiration', 10));
    await this.updateSession(sInstance);
  }
}
