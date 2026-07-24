import { SessionProvider, ISession, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession.js';
import { InsertBehaviour } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';

export * from './models/DbSession.js';
export * from './migrations/UserSessionDBSqlMigration_2022_06_28_01_01_01.js';

/**
 * Relational-db backed session store. Conforms to the `@spinajs/rbac`
 * `SessionProvider` contract: ownership is the numeric `UserId`, expiration is
 * owned by the injected strategy (`this.Expiration`) and persisted verbatim, and
 * `Data` is (de)serialized with the shared session codec.
 */
@Injectable(SessionProvider)
export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  /**
   * How often expired rows are swept, in milliseconds. Reads the correctly
   * spelled `rbac.session.db.cleanupInterval` key (fixes B2 — the historic typo
   * `cleanupInteval` meant the configured value was ignored).
   */
  @Config('rbac.session.db.cleanupInterval', {
    defaultValue: 100000,
  })
  protected CleanupInterval: number;

  public async resolve() {
    const timer = setInterval(async () => {
      const c = await DbSession.destroy().where('Expiration', '<=', DateTime.now());

      this.Log.info(`Cleaned up expired session, count: ${c.RowsAffected}`);
    }, this.CleanupInterval);

    // do not keep the process alive solely for the cleanup timer
    timer.unref?.();
  }

  public async restore(sessionId: string): Promise<ISession | null> {
    const row = await DbSession.where({
      SessionId: sessionId,
    }).first();

    if (!row) {
      return null;
    }

    const session = this.toSession(row);

    // an expired row is treated as absent
    if (this.isExpired(session)) {
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    // Persist `Expiration` verbatim (fixes B3). Only a brand-new session with no
    // scheduled expiration is given its initial expiry via the strategy.
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    const s = await DbSession.getOrNew({
      SessionId: session.SessionId,
    });

    s.SessionId = session.SessionId;
    s.CreatedAt = session.Creation;
    // column is nullable; a never-expiring session persists a NULL Expiration
    s.Expiration = (session.Expiration ?? null) as DateTime;
    s.UserId = session.UserId;
    s.Data = encodeSessionData(session.Data);

    await s.insert(InsertBehaviour.InsertOrUpdate);
  }

  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    const renewed = this.Expiration.renew(session);

    // unchanged (e.g. AbsoluteExpiration) — skip the write, report false
    if (this.expirationEquals(current, renewed)) {
      return false;
    }

    session.Expiration = renewed;
    await DbSession.update({
      Expiration: renewed,
    }).where('SessionId', session.SessionId);

    return true;
  }

  public async delete(sessionId: string): Promise<void> {
    await DbSession.destroy(sessionId);
  }

  public async deleteByUser(userId: number): Promise<void> {
    await DbSession.destroy().where('UserId', userId);
  }

  public async listByUser(userId: number): Promise<ISession[]> {
    const rows = await DbSession.where('UserId', userId);

    return rows.map((r) => this.toSession(r)).filter((s) => !this.isExpired(s));
  }

  public async truncate(): Promise<void> {
    await DbSession.truncate();
  }

  private toSession(row: DbSession): ISession {
    return new UserSession({
      SessionId: row.SessionId,
      UserId: row.UserId,
      Creation: row.CreatedAt,
      Expiration: row.Expiration ?? undefined,
      Data: decodeSessionData(row.Data),
    });
  }

  private expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}
