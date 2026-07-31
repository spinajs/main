import { SessionProvider, ISession, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession.js';
import { InsertBehaviour } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';

export * from './models/DbSession.js';
export * from './migrations/UserSessionDBSqlMigration_2022_06_28_01_20_00.js';
export * from './migrations/UserSessionDataJson_2026_07_31_00_00_00.js';
export * from './migrations/UserSessionTimestamps_2026_07_31_00_00_01.js';

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
      const count = await this.cleanupExpired();

      this.Log.info(`Cleaned up expired session, count: ${count}`);
    }, this.CleanupInterval);

    // do not keep the process alive solely for the cleanup timer
    timer.unref?.();
  }

  /**
   * Removes every session whose expiration has passed.
   *
   * Extracted from the cleanup timer so it can be exercised directly.
   *
   * @returns how many sessions were removed
   */
  public async cleanupExpired(): Promise<number> {
    // NOTE: same reason as in deleteByUser — destroy() only builds a DELETE
    // bounded by primary keys, so the expired rows are looked up first.
    // `destroy().where(...)` threw on every tick and no session was ever
    // cleaned up.
    const expired = await DbSession.where('Expiration', '<=', DateTime.now());

    if (expired.length === 0) {
      return 0;
    }

    await DbSession.destroy(expired.map((s) => s.SessionId));

    return expired.length;
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
    // NOTE: destroy() refuses to build an unbounded DELETE, so the sessions of
    // the user are resolved to their primary keys first. `destroy().where(...)`
    // threw "Cannot destroy without primary keys", which broke every forced
    // logout ( admin "log out user" route included ).
    const sessions = await DbSession.where('UserId', userId);

    if (sessions.length === 0) {
      return;
    }

    await DbSession.destroy(sessions.map((s) => s.SessionId));
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
      Data: decodeSessionData(sessionDataFromColumn(row.Data)),
    });
  }

  private expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}

/**
 * Presents whatever the driver hands back for `user_sessions.Data` in one of the
 * two shapes {@link decodeSessionData} understands - a JSON string, or an
 * already-parsed object graph.
 *
 * `Data` is a MySQL `json` column, so mysql2 parses it for us and this function
 * passes the OBJECT straight through: no `JSON.stringify` / `JSON.parse`
 * round-trip, the decoder walks the graph natively. Strings pass through just as
 * untouched - sqlite has no json type and returns the stored text, and a
 * connection configured otherwise (`typeCast`, an older column, a text-typed
 * table that has not run the converging migration yet) may still yield one.
 *
 * The only value actually converted is a `Buffer`: a blob-ish column or a driver
 * in binary mode delivers one, and neither the object walk nor `JSON.parse` can
 * read it. Note it is decoded to text rather than handed over as an object -
 * treating a Buffer as an object graph would walk its byte indices and decode to
 * an empty session.
 *
 * The write path is untouched: `encodeSessionData` still stores a string, which
 * a `json` column accepts verbatim (mysql2 does NOT auto-serialize objects into
 * json columns, and `DbSession.Data` deliberately carries no `@Json()`
 * decorator - the ORM's JsonValueConverter would `JSON.stringify` the already
 * encoded string and double-encode every session).
 */
function sessionDataFromColumn(data: unknown): string | unknown {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  return data;
}
