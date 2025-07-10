import { SessionProvider, ISession, UserSession, User } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession.js';
import { InsertBehaviour } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import _ from 'lodash';
import { replacer } from '@spinajs/util';

export * from './models/DbSession.js';
export * from './migrations/UserSessionDBSqlMigration_2022_06_28_01_01_01.js';

@Injectable(SessionProvider)
export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  @Config('rbac.session.db.cleanupInteval', {
    defaultValue: 100000,
  })
  protected CleanupInterval: any;

  @Config('rbac.session.expiration')
  protected DefaultExpirationTime: number;

  public async resolve() {
    setInterval(async () => {
      const c = await DbSession.destroy().where('Expiration', '<=', DateTime.now());

      this.Log.info(`Cleaned up expired session, count: ${c.RowsAffected}`);
    }, this.CleanupInterval);
  }

  public async restore(sessionId: string): Promise<ISession> {
    const session = await DbSession.where({
      SessionId: sessionId,
    }).first();

    if (!session) {
      return null;
    }

    if (session.Expiration < DateTime.now()) {
      return null;
    }

    const sData = JSON.parse(session.Data);

    return new UserSession({
      SessionId: session.SessionId,
      Creation: session.CreatedAt,
      Data: new Map(Object.entries(sData)),
      Expiration: session.Expiration,
    });
  }

  public async delete(sessionId: string): Promise<void> {
    await DbSession.destroy(sessionId);
  }

  public async save(sessionOrId: string | ISession, data?: Map<string, unknown>): Promise<void> {

    const sessionId = _.isString(sessionOrId) ? sessionOrId : sessionOrId.SessionId;
    const userId = _.isString(sessionOrId) ? null : sessionOrId.UserId;
    const sData = _.isString(sessionOrId) ? data : sessionOrId.Data;
    let sCreationTime = DateTime.now();
    let sExpirationTime = DateTime.now().plus({ minutes: this.DefaultExpirationTime });

    const s = await DbSession.getOrNew({
      SessionId: sessionId,
      CreatedAt: sCreationTime,
      Expiration: sExpirationTime,
      UserId: userId
    });
    s.Data = JSON.stringify(Object.fromEntries(sData), replacer);
    await s.insert(InsertBehaviour.InsertOrUpdate);
  }

  public async touch(session: ISession): Promise<void> {
    await DbSession.update({
      Expiration: session.Expiration,
    }).where('SessionId', session.SessionId);
  }

  public async logsOut(user: User): Promise<void> {
    const sessionsToDelete = await DbSession.where('UserId', user.Id);

    if (sessionsToDelete.length > 0) {
      await DbSession.destroy(sessionsToDelete.map((x) => x.SessionId));
    }
  }

  public async truncate(): Promise<void> {
    await DbSession.truncate();
  }
}
