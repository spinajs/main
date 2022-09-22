import { SessionProvider, Session, ISession } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession';
import { InsertBehaviour } from '@spinajs/orm';
import { reviver, replacer } from '@spinajs/util';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';

@Injectable(SessionProvider)
export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  @Config('rbac.session.db.cleanupInteval', 100000)
  protected CleanupInterval: any;

  public async resolve() {
    setInterval(async () => {
      const c = await DbSession.destroy().where('Expiration', '<=', DateTime.now());

      this.Log.info(`Cleaned up expired session, count: ${c}`);
    }, this.CleanupInterval);
  }

  public async restore(sessionId: string): Promise<Session> {
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

  public async touch(session: ISession): Promise<void> {
    await DbSession.update({
      Expiration: session.Expiration,
    }).where('SessionId', session.SessionId);
  }
  public async truncate(): Promise<void> {
    await DbSession.truncate();
  }
}
