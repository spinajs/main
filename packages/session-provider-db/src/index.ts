import { SessionProvider, Session, ISession } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession';
import { InsertBehaviour } from '@spinajs/orm';
import { reviver, replacer } from '@spinajs/util';

@Injectable(SessionProvider)
export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  public async restore(sessionId: string): Promise<Session> {
    const session = await DbSession.where({
      SessionId: sessionId,
    }).first();

    if (!session) {
      return null;
    }

    return new Session({
      SessionId: session.SessionId,
      Creation: session.CreatedAt,
      Data: JSON.parse(session.Data, reviver),
      Expiration: session.Expiration,
    });
  }

  public async delete(sessionId: string): Promise<void> {
    await DbSession.destroy(sessionId);
  }

  public async save(s: ISession): Promise<void> {
    const session = new DbSession({
      ...s,
      Data: JSON.stringify(s.Data, replacer),
    });

    await session.insert(InsertBehaviour.InsertOrUpdate);
  }
}
