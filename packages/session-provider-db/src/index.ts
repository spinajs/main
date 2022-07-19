import { SessionProvider, Session, ISession } from '@spinajs/rbac';
import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession';
import { InsertBehaviour } from '@spinajs/orm';

@Injectable(SessionProvider)
export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  // tslint:disable-next-line: no-empty
  public async resolveAsync() {}

  public async restore(sessionId: string): Promise<Session> {
    const session = await DbSession.where({
      SessionId: sessionId,
    }).first();

    if (!session) {
      return null;
    }

    return new Session({
      SessionId: session.Id,
      Creation: session.CreatedAt,
      Data: JSON.parse(session.Data),
      Expiration: session.Expiration,
    });
  }

  public async delete(sessionId: string): Promise<void> {
    await DbSession.destroy(sessionId);
  }

  public async save(s: ISession): Promise<void> {
    const session = new DbSession({
      ...s,
      Data: JSON.stringify(s.Data),
    });

    await session.insert(InsertBehaviour.InsertOrUpdate);
  }
}
