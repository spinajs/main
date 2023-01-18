import { SessionProvider, Session, ISession } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession';
import { InsertBehaviour } from '@spinajs/orm';
import { replacer } from '@spinajs/util';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import _ from 'lodash';

export * from './models/DbSession';
export * from './migrations/UserSessionDBSqlMigration_2022_06_28_01_01_01';

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

    const sData = JSON.parse(session.Data);

    return new Session({
      SessionId: session.SessionId,
      Creation: session.CreatedAt,
      Data: new Map(Object.entries(sData)),
      Expiration: session.Expiration,
    });
  }

  public async delete(sessionId: string): Promise<void> {
    await DbSession.destroy(sessionId);
  }

  public async save(sessionOrId: string | ISession, data?: object): Promise<void> {
    let sId = '';
    let sData = null;
    let sCreationTime = DateTime.now();
    let sExpirationTime = DateTime.now().plus({ minutes: this.DefaultExpirationTime });

    if (_.isString(sessionOrId)) {
      sId = sessionOrId;
      sData = data;
    } else {
      sId = sessionOrId.SessionId;
      sData = Object.fromEntries(sessionOrId.Data);
      sCreationTime = sessionOrId.Creation;
      sExpirationTime = sessionOrId.Expiration;
    }

    const session = new DbSession({
      SessionId: sId,
      CreatedAt: sCreationTime,
      Expiration: sExpirationTime,
      Data: JSON.stringify(sData, replacer),
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
