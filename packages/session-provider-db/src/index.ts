import { SessionProvider, UserSession, encodeSessionData, decodeSessionData, adaptLegacySession } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DbSession } from './models/DbSession.js';
import { DeleteQueryBuilder, InsertBehaviour, createQuery } from '@spinajs/orm';
import type { IUpdateResult } from '@spinajs/orm';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { DateTime } from 'luxon';
import { refKey, refOf, sessionDataFromColumn } from './session-row.js';

export * from './models/DbSession.js';
export * from './migrations/UserSessionDBSqlMigration_2022_06_28_01_20_00.js';
export * from './migrations/UserSessionDataJson_2026_07_31_00_00_00.js';
export * from './migrations/UserSessionTimestamps_2026_07_31_00_00_01.js';
export * from './migrations/UserSessionIdHash_2026_10_02_00_00_00.js';

const sameRef = (a: IdentityRef | undefined, b: IdentityRef) => !!a && a.type === b.type && a.id === b.id;

const belongsTo = (s: ISession, subject: IdentityRef, includeImpersonations?: boolean) => sameRef(s.Subject, subject) || (includeImpersonations === true && sameRef(s.Impersonator, subject));

const rowsAffected = (result: unknown) => (result as IUpdateResult | undefined)?.RowsAffected ?? 0;

/**
 * Relational-db backed session store. Subject, Impersonator and State live in
 * their own indexed columns (principal keys); rows written by 2.x have none of
 * them and are adapted from their Data on every read.
 */
@Injectable(SessionProvider)
export class DbSessionStore extends SessionProvider {
  @Logger('db-session-store')
  protected Log: Log;

  @Config('authn.session.db.cleanupInterval', {
    defaultValue: 100000,
  })
  protected CleanupInterval: number;

  protected CleanupTimer: ReturnType<typeof setInterval> | undefined;

  public async resolve() {
    this.CleanupTimer = setInterval(async () => {
      // An unhandled rejection here would end the process; the next tick retries.
      try {
        const count = await this.cleanupExpired();
        this.Log.info(`Cleaned up expired session, count: ${count}`);
      } catch (err) {
        this.Log.error(err as Error, 'Expired session cleanup failed');
      }
    }, this.CleanupInterval);

    // do not keep the process alive solely for the cleanup timer
    this.CleanupTimer.unref?.();
  }

  public async dispose() {
    clearInterval(this.CleanupTimer);
    this.CleanupTimer = undefined;
  }

  /**
   * Removes every session whose expiration has passed.
   *
   * @returns how many sessions were removed
   */
  public async cleanupExpired(): Promise<number> {
    // destroy() only builds a DELETE bounded by primary keys, so the expired
    // rows are looked up first.
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

    if (!session || this.isExpired(session)) {
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
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
    s.UserId = null;
    s.Subject = refKey(session.Subject);
    s.ImpersonatorId = session.Impersonator ? refKey(session.Impersonator) : null;
    s.State = session.State;
    s.Data = encodeSessionData(session.Data);

    await s.insert(InsertBehaviour.InsertOrUpdate);
  }

  /** Update-only: a row deleted since the read stays deleted, and a row stored in another State is left alone (SR-07). */
  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    this.applyRenewedExpiration(session);

    const now = DateTime.now();
    const result = await DbSession.update({
      Expiration: (session.Expiration ?? null) as DateTime,
      Data: encodeSessionData(session.Data),
    })
      .where('SessionId', session.SessionId)
      .where(function () {
        this.whereNull('State').orWhere('State', session.State);
      })
      .where(function () {
        this.whereNull('Expiration').orWhere('Expiration', '>', now);
      });

    if (rowsAffected(result) === 0) {
      session.Expiration = current;
      return false;
    }

    return !this.expirationEquals(current, session.Expiration);
  }

  public async delete(sessionId: string): Promise<void> {
    await DbSession.destroy(sessionId);
  }

  /**
   * Live rows are deleted by key so the count is exact; a second DELETE by
   * Subject / ImpersonatorId then also ends 3.0 rows saved since the read
   * (a rotation racing a ban). 2.x rows are found by decoding their Data.
   */
  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    const targets = (await this.matching(subject, opts?.includeImpersonations)).filter((s) => s.SessionId !== opts?.except);
    const live = targets.filter((s) => !this.isExpired(s)).map((s) => s.SessionId);
    const dead = targets.filter((s) => this.isExpired(s)).map((s) => s.SessionId);

    const count = live.length > 0 ? rowsAffected(await DbSession.destroy(live)) : 0;
    if (dead.length > 0) {
      await DbSession.destroy(dead);
    }

    const key = refKey(subject);
    const { query } = createQuery(DbSession, DeleteQueryBuilder);
    query.where(function () {
      this.where('Subject', key);
      if (opts?.includeImpersonations === true) {
        this.orWhere('ImpersonatorId', key);
      }
    });
    if (opts?.except !== undefined) {
      query.where('SessionId', '!=', opts.except);
    }
    await query;

    return count;
  }

  public async listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<ISession[]> {
    return (await this.matching(subject, opts?.includeImpersonations)).filter((s) => !this.isExpired(s));
  }

  public async truncate(): Promise<void> {
    await DbSession.truncate();
  }

  /** Rows of the subject, expired ones included: 3.0 rows through the indexed columns, 2.x rows (Subject NULL) by their Data. */
  protected async matching(subject: IdentityRef, includeImpersonations?: boolean): Promise<ISession[]> {
    const key = refKey(subject);
    const rows = await DbSession.where(function () {
      this.where('Subject', key);
      if (includeImpersonations === true) {
        this.orWhere('ImpersonatorId', key);
      }
    });
    const legacy = await DbSession.where('Subject', null);

    return [...rows, ...legacy].map((r) => this.toSession(r, true)).filter((s): s is ISession => !!s && belongsTo(s, subject, includeImpersonations));
  }

  /**
   * The 3.0 view of a row; null for a 2.x row without an owner. `lenient`
   * (revocation and listing): a row whose Data does not decode keeps the owner
   * its columns give and an empty Data, so one bad row cannot make a
   * revokeAll throw for everybody; a 2.x row then has no owner and is skipped.
   */
  protected toSession(row: DbSession, lenient = false): ISession | null {
    let data: Map<string, unknown>;
    try {
      data = decodeSessionData(sessionDataFromColumn(row.Data));
    } catch (err) {
      if (!lenient) {
        throw err;
      }
      this.Log.warn(`Session row with undecodable Data skipped in a subject lookup`);
      data = new Map();
    }
    const session = new UserSession({
      SessionId: row.SessionId,
      Creation: row.CreatedAt,
      Expiration: row.Expiration ?? undefined,
      Data: data,
    });

    const subject = refOf(row.Subject);
    if (!subject) {
      return adaptLegacySession(session);
    }

    session.Subject = subject;
    session.Impersonator = refOf(row.ImpersonatorId);
    session.State = row.State === 'active' ? 'active' : 'pending';
    return session;
  }

  private expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}
