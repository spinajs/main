import { SessionProvider, ISession, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession.js';
import { InsertBehaviour } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';

export * from './models/DbSession.js';
export * from './migrations/UserSessionDBSqlMigration_2022_06_28_01_20_00.js';

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
      Data: decodeSessionData(sessionDataAsJson(row.Data)),
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
 * Normalizes whatever the driver hands back for `user_sessions.Data` into the
 * JSON string `decodeSessionData` expects.
 *
 * mysql2 hands JSON columns back as objects it has already parsed; deployed
 * installs have a text-typed column and keep the string path. A database whose
 * table was created by the `table.json('Data')` revision of the migration
 * therefore yields an object, and `JSON.parse` on it failed with
 * `"[object Object]" is not valid JSON` - every session read, i.e. every
 * request after login, 500'd.
 *
 * The object is re-serialized rather than handed to the decoder as-is because
 * `decodeSessionData`'s reviver is what turns the payload back into a `Map`
 * (and its tagged `DateTime` / `Set` values back into instances). Passing the
 * raw object through would produce a silently EMPTY session instead of an
 * error - a worse failure than the one being fixed. The round-trip runs once
 * per session read and the payload is small.
 *
 * The write path is untouched: `encodeSessionData` still stores a string, which
 * both a `text` and a `json` column accept.
 */
function sessionDataAsJson(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }

  // a blob-ish column can arrive as a Buffer; stringifying one would yield
  // `{"type":"Buffer",...}` and decode to an empty session
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  return JSON.stringify(data ?? null);
}
