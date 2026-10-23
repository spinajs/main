import { Injectable, Singleton } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { rowsAffected } from '@spinajs/orm';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';
import type { DateTime } from 'luxon';

import { UPLOAD_BLOBS_TABLE, UPLOAD_CONNECTION, UPLOAD_PARTS_TABLE, UPLOAD_SESSIONS_TABLE } from './constants.js';
import { UploadError } from './errors.js';
import { UploadBlob } from './models/UploadBlob.js';
import type { BlobKind, BlobState } from './models/UploadBlob.js';
import { UploadPart } from './models/UploadPart.js';
import { UploadSession } from './models/UploadSession.js';
import type { FinalEventName, UploadStatus } from './types.js';

/** A keyset page: up to `limit` rows whose id sorts after `after`, in id order. */
export interface KeysetPage {
  readonly after: string;
  readonly limit: number;
}

/** Purged whole after upload.sweeper.retainFinished; a completed session keeps its row and file (docs/upload/11-sweeper.md). */
const PURGED_STATUSES: readonly UploadStatus[] = ['failed', 'aborted', 'expired'];

export interface NewSessionRow {
  readonly id: string;
  readonly owner: string | null;
  readonly name: string;
  readonly size: number;
  readonly part_size: number;
  readonly part_count: number;
  readonly declared_sha256: string | null;
  readonly declared_mime: string | null;
  readonly metadata: Record<string, unknown>;
  readonly temp_fs: string;
  readonly files_fs: string;
  readonly created_at: DateTime;
  readonly expires_at: DateTime;
}

export interface PartRow {
  readonly session_id: string;
  readonly number: number;
  readonly size: number;
  readonly sha256: string;
  readonly storage_key: string;
  readonly detected_mime: string | null;
  readonly received_at: DateTime;
}

export interface NewBlobRow {
  readonly id: string;
  readonly session_id: string;
  readonly fs: string;
  readonly key: string;
  readonly kind: BlobKind;
}

export interface CompletedValues {
  readonly sha256: string;
  readonly file_key: string;
  readonly detected_mime: string | null;
}

// SQLite and Postgres count matched rows; MySQL does through mysql2's default CLIENT_FOUND_ROWS (scheduler/src/store/LeaseStore.ts:37-41).
const matched = (result: unknown): boolean => rowsAffected(result) === 1;

// MySQL ER_LOCK_DEADLOCK and ER_LOCK_WAIT_TIMEOUT by errno; Postgres serialization_failure and deadlock_detected by SQLSTATE.
const MYSQL_LOCK_CONFLICTS = new Set([1213, 1205]);
const POSTGRES_LOCK_CONFLICTS = new Set(['40001', '40P01']);

/** The drivers throw an OrmException that carries the native error in `inner`. */
function isLockConflict(err: unknown): boolean {
  let current = err as { errno?: unknown; code?: unknown; inner?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current.errno === 'number' && MYSQL_LOCK_CONFLICTS.has(current.errno)) return true;
    if (typeof current.code === 'string' && POSTGRES_LOCK_CONFLICTS.has(current.code)) return true;
    current = (current.inner ?? current.cause) as typeof current;
  }
  return false;
}

/**
 * Every statement on the upload tables. A state change is one conditional UPDATE whose WHERE is the transition rule, so
 * the matched-row count says whether it applied; a model save would write every changed column instead
 * (docs/upload/12-database.md).
 */
@Singleton()
@Injectable()
export class UploadStore {
  @Logger('upload')
  protected Log: Log;

  public get Driver(): OrmDriver {
    const driver = UploadSession.getModelDescriptor().Driver;
    if (!driver) {
      throw new InvalidOperation(`upload: connection ${UPLOAD_CONNECTION} is not configured (db.Aliases.${UPLOAD_CONNECTION})`);
    }
    return driver;
  }

  /** Statements in `work` run on the transaction's connection through AsyncLocalStorage (orm/src/driver.ts:486-500). */
  public transaction<R>(work: () => Promise<R>): Promise<R> {
    return this.Driver.transaction(() => work());
  }

  public async insertSession(row: NewSessionRow): Promise<void> {
    await this.Driver.insert()
      .into(UPLOAD_SESSIONS_TABLE)
      .values({ ...row, metadata: JSON.stringify(row.metadata), status: 'open', updated_at: row.created_at });
  }

  public async findSession(id: string, owner: string | null = null): Promise<UploadSession | undefined> {
    return await UploadSession.query().where('id', id).ofOwner(owner).first();
  }

  public async requireSession(id: string): Promise<UploadSession> {
    const session = await this.findSession(id);
    if (!session) throw new UploadError('upload.not_found', `upload ${id} not found`);
    return session;
  }

  /** Bounded by maxOpenSessionsPerOwner, so the rows are few; the (owner, status) index serves it. */
  public async openSessionsOf(owner: string): Promise<number> {
    return (await UploadSession.query().ofOwner(owner).open()).length;
  }

  /**
   * create's count-then-insert in one transaction; false when the owner already has `cap` open sessions. SQLite runs one
   * transaction at a time. On Postgres and MySQL the owner's open rows are locked first, so a second create of the same
   * owner waits for the first to commit and its count then sees the new row. An owner with no open row has nothing to lock,
   * so its concurrent first creates are not serialised there: the cap is soft (docs/upload/06-limits.md).
   *
   * A transaction the database aborts on a lock conflict (deadlock, lock wait timeout, serialization failure) is retried
   * once, unless it runs inside a caller's transaction: the caller owns that transaction and its retry (MySQL 1205 rolls back
   * only the statement, and a Postgres savepoint rollback leaves the outer transaction usable).
   */
  public async insertSessionWithinCap(row: NewSessionRow & { readonly owner: string }, cap: number): Promise<boolean> {
    const attempt = () =>
      this.transaction(async () => {
        await this.lockOwner(row.owner);
        if ((await this.openSessionsOf(row.owner)) >= cap) return false;
        await this.insertSession(row);
        return true;
      });
    const nested = this.Driver.CurrentTransaction !== undefined;
    try {
      return await attempt();
    } catch (err) {
      if (nested || !isLockConflict(err)) throw err;
      this.Log.warn({ owner: row.owner, error: err }, 'Upload create for owner ${owner} hit a lock conflict; retrying once');
      return await attempt();
    }
  }

  /** Writes the owner's own value back: a no-op change that takes the row locks. */
  protected async lockOwner(owner: string): Promise<void> {
    await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ owner }).where({ owner, status: 'open' });
  }

  /**
   * putPart's first statement in its transaction; it takes the row lock the complete claim also needs.
   * An open session past expires_at does not match: it may have expired while the body streamed.
   */
  public async touchOpen(id: string, now: DateTime): Promise<boolean> {
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ updated_at: now }).where({ id, status: 'open' }).where('expires_at', '>', now));
  }

  /** An open session not yet past expires_at, or an assembling one whose claim is older than `staleBefore`. */
  public async claim(id: string, token: string, now: DateTime, staleBefore: DateTime, declaredSha256: string | null): Promise<boolean> {
    const data: Record<string, unknown> = { status: 'assembling', claim_token: token, claimed_at: now, updated_at: now };
    if (declaredSha256 !== null) data.declared_sha256 = declaredSha256;
    const result = await this.Driver.update()
      .in(UPLOAD_SESSIONS_TABLE)
      .update(data)
      .where('id', id)
      .where(function (this: IWhereBuilder<unknown>) {
        this.where(function (this: IWhereBuilder<unknown>) {
          this.where('status', 'open').where('expires_at', '>', now);
        }).orWhere(function (this: IWhereBuilder<unknown>) {
          this.where('status', 'assembling').where('claimed_at', '<', staleBefore);
        });
      });
    return matched(result);
  }

  public async release(id: string, token: string, now: DateTime): Promise<boolean> {
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ status: 'open', claim_token: null, claimed_at: null, updated_at: now }).where({ id, status: 'assembling', claim_token: token }));
  }

  public async complete(id: string, token: string, values: CompletedValues, now: DateTime): Promise<boolean> {
    const final: FinalEventName = 'UploadCompleted';
    return matched(
      await this.Driver.update()
        .in(UPLOAD_SESSIONS_TABLE)
        .update({ ...values, status: 'completed', completed_at: now, updated_at: now, claim_token: null, claimed_at: null, final_event: final })
        .where({ id, status: 'assembling', claim_token: token }),
    );
  }

  public async fail(id: string, token: string, code: string, message: string, now: DateTime): Promise<boolean> {
    const final: FinalEventName = 'UploadFailed';
    return matched(
      await this.Driver.update()
        .in(UPLOAD_SESSIONS_TABLE)
        .update({ status: 'failed', failure_code: code, failure_message: message, updated_at: now, claim_token: null, claimed_at: null, final_event: final })
        .where({ id, status: 'assembling', claim_token: token }),
    );
  }

  /** An assembly in progress is never aborted. */
  public async abort(id: string, now: DateTime): Promise<boolean> {
    const final: FinalEventName = 'UploadAborted';
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ status: 'aborted', updated_at: now, final_event: final }).where({ id, status: 'open' }));
  }

  public async expire(id: string, now: DateTime): Promise<boolean> {
    const final: FinalEventName = 'UploadExpired';
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ status: 'expired', updated_at: now, final_event: final }).where({ id, status: 'open' }).where('expires_at', '<=', now));
  }

  public async markHandled(id: string, now: DateTime): Promise<boolean> {
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ handled_at: now }).where('id', id).whereNull('handled_at'));
  }

  public async markFinalEmitted(id: string, event: FinalEventName, now: DateTime): Promise<boolean> {
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ final_event_at: now }).where({ id, final_event: event }).whereNull('final_event_at'));
  }

  public async listParts(sessionId: string): Promise<UploadPart[]> {
    return await UploadPart.query().ofSession(sessionId).orderBy('number');
  }

  public async findPart(sessionId: string, part: number): Promise<UploadPart | undefined> {
    return await UploadPart.query().ofSession(sessionId).where('number', part).first();
  }

  /** One row per (session_id, number); a resend replaces it. */
  public async upsertPart(row: PartRow): Promise<void> {
    await this.Driver.insert().into(UPLOAD_PARTS_TABLE).values(row).onDuplicate(['session_id', 'number']).update(['size', 'sha256', 'storage_key', 'detected_mime', 'received_at']);
  }

  /** Matches the key as well, so a part that a resend replaced in the meantime is kept. */
  public async deleteParts(sessionId: string, parts: readonly Pick<UploadPart, 'number' | 'storage_key'>[]): Promise<void> {
    for (const part of parts) {
      await this.Driver.del().from(UPLOAD_PARTS_TABLE).where({ session_id: sessionId, number: part.number, storage_key: part.storage_key });
    }
  }

  public async deleteAllParts(sessionId: string): Promise<void> {
    await this.Driver.del().from(UPLOAD_PARTS_TABLE).where({ session_id: sessionId });
  }

  public async insertBlob(row: NewBlobRow, now: DateTime): Promise<void> {
    const state: BlobState = 'writing';
    await this.Driver.insert()
      .into(UPLOAD_BLOBS_TABLE)
      .values({ ...row, state, created_at: now, updated_at: now });
  }

  /** False when the blob is not in a `from` state any more, e.g. the sweeper already reclaimed it. */
  public async setBlobState(id: string, from: BlobState | readonly BlobState[], to: BlobState, now: DateTime): Promise<boolean> {
    return matched(await this.Driver.update().in(UPLOAD_BLOBS_TABLE).update({ state: to, updated_at: now }).where({ id }).whereIn('state', [...[from].flat()]));
  }

  public async setBlobStateByKey(sessionId: string, fsName: string, key: string, from: BlobState | readonly BlobState[], to: BlobState, now: DateTime): Promise<boolean> {
    return matched(
      await this.Driver.update()
        .in(UPLOAD_BLOBS_TABLE)
        .update({ state: to, updated_at: now })
        .where({ session_id: sessionId, fs: fsName, key })
        .whereIn('state', [...[from].flat()]),
    );
  }

  /** Live blobs only: a part still being written stays 'writing' and discards itself when its commit fails. */
  public async setSessionBlobsState(sessionId: string, kind: BlobKind, state: BlobState, now: DateTime): Promise<void> {
    await this.Driver.update().in(UPLOAD_BLOBS_TABLE).update({ state, updated_at: now }).where({ session_id: sessionId, kind, state: 'live' });
  }

  public async listBlobs(sessionId: string, state: BlobState): Promise<UploadBlob[]> {
    return await UploadBlob.query().ofSession(sessionId).inState(state);
  }

  /** False when the row was already deleted, e.g. by a concurrent sweep. */
  public async deleteBlob(id: string): Promise<boolean> {
    return matched(await this.Driver.del().from(UPLOAD_BLOBS_TABLE).where({ id }));
  }

  public async openExpiredBy(now: DateTime, page: KeysetPage): Promise<UploadSession[]> {
    return await UploadSession.query().open().expiredBefore(now).where('id', '>', page.after).orderBy('id').take(page.limit);
  }

  public async staleClaims(staleBefore: DateTime, page: KeysetPage): Promise<UploadSession[]> {
    return await UploadSession.query().where('status', 'assembling').where('claimed_at', '<', staleBefore).where('id', '>', page.after).orderBy('id').take(page.limit);
  }

  /** Made final before `before`: a session made final since may still have its own emit in flight. */
  public async owedFinalEvents(before: DateTime, page: KeysetPage): Promise<UploadSession[]> {
    return await UploadSession.query().whereNotNull('final_event').whereNull('final_event_at').where('updated_at', '<', before).where('id', '>', page.after).orderBy('id').take(page.limit);
  }

  /** Only sessions that still have part rows: a purged one has none, so later runs do not read it again. */
  public async retainedCompleted(before: DateTime, page: KeysetPage): Promise<UploadSession[]> {
    return await UploadSession.query()
      .where('status', 'completed')
      .where('updated_at', '<', before)
      .whereNotNull('final_event_at')
      .whereIn('id', this.Driver.select().columns(['session_id']).from(UPLOAD_PARTS_TABLE))
      .where('id', '>', page.after)
      .orderBy('id')
      .take(page.limit);
  }

  public async retainedFinished(before: DateTime, page: KeysetPage): Promise<UploadSession[]> {
    return await UploadSession.query()
      .whereIn('status', [...PURGED_STATUSES])
      .where('updated_at', '<', before)
      .whereNotNull('final_event_at')
      .where('id', '>', page.after)
      .orderBy('id')
      .take(page.limit);
  }

  /** `updatedBefore` null: any age. */
  public async sweepableBlobs(state: BlobState, updatedBefore: DateTime | null, page: KeysetPage): Promise<UploadBlob[]> {
    const query = UploadBlob.query().inState(state).where('id', '>', page.after);
    return await (updatedBefore === null ? query : query.updatedBefore(updatedBefore)).orderBy('id').take(page.limit);
  }

  /** Live part blobs become garbage and the part rows go, together; false when the session had no part rows left. */
  public async dropParts(sessionId: string, now: DateTime): Promise<boolean> {
    return this.transaction(async () => {
      await this.setSessionBlobsState(sessionId, 'part', 'garbage', now);
      return rowsAffected(await this.Driver.del().from(UPLOAD_PARTS_TABLE).where({ session_id: sessionId })) > 0;
    });
  }

  /** Every writing or live blob of the session becomes garbage; false when there was none. */
  public async abandonBlobs(sessionId: string, now: DateTime): Promise<boolean> {
    const state: BlobState = 'garbage';
    return rowsAffected(await this.Driver.update().in(UPLOAD_BLOBS_TABLE).update({ state, updated_at: now }).where({ session_id: sessionId }).whereIn('state', ['writing', 'live'])) > 0;
  }

  /** Only a failed, aborted or expired session whose final event was delivered; false when it is not one (any more). */
  public async deleteFinishedSession(id: string): Promise<boolean> {
    return matched(await this.Driver.del().from(UPLOAD_SESSIONS_TABLE).where('id', id).whereIn('status', [...PURGED_STATUSES]).whereNotNull('final_event_at'));
  }
}
