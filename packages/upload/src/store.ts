import { Injectable, Singleton } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { rowsAffected } from '@spinajs/orm';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';
import type { DateTime } from 'luxon';

import { UPLOAD_BLOBS_TABLE, UPLOAD_CONNECTION, UPLOAD_PARTS_TABLE, UPLOAD_SESSIONS_TABLE } from './constants.js';
import { UploadError } from './errors.js';
import { UploadBlob } from './models/UploadBlob.js';
import type { BlobKind, BlobState } from './models/UploadBlob.js';
import { UploadPart } from './models/UploadPart.js';
import { UploadSession } from './models/UploadSession.js';
import type { FinalEventName } from './types.js';

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

/**
 * Every statement on the upload tables. A state change is one conditional UPDATE whose WHERE is the transition rule, so
 * the matched-row count says whether it applied (spec §5); a model save would write every changed column instead.
 */
@Singleton()
@Injectable()
export class UploadStore {
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

  /** putPart's first statement in its transaction; it takes the row lock the complete claim also needs (spec §4.1 step 4). */
  public async touchOpen(id: string, now: DateTime): Promise<boolean> {
    return matched(await this.Driver.update().in(UPLOAD_SESSIONS_TABLE).update({ updated_at: now }).where({ id, status: 'open' }));
  }

  /** Spec §5: an open session, or an assembling one whose claim is older than `staleBefore`. */
  public async claim(id: string, token: string, now: DateTime, staleBefore: DateTime, declaredSha256: string | null): Promise<boolean> {
    const data: Record<string, unknown> = { status: 'assembling', claim_token: token, claimed_at: now, updated_at: now };
    if (declaredSha256 !== null) data.declared_sha256 = declaredSha256;
    const result = await this.Driver.update()
      .in(UPLOAD_SESSIONS_TABLE)
      .update(data)
      .where('id', id)
      .where(function (this: IWhereBuilder<unknown>) {
        this.where('status', 'open').orWhere(function (this: IWhereBuilder<unknown>) {
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
        .update({ ...values, status: 'completed', completed_at: now, updated_at: now, claim_token: null, final_event: final })
        .where({ id, status: 'assembling', claim_token: token }),
    );
  }

  public async fail(id: string, token: string, code: string, message: string, now: DateTime): Promise<boolean> {
    const final: FinalEventName = 'UploadFailed';
    return matched(
      await this.Driver.update()
        .in(UPLOAD_SESSIONS_TABLE)
        .update({ status: 'failed', failure_code: code, failure_message: message, updated_at: now, claim_token: null, final_event: final })
        .where({ id, status: 'assembling', claim_token: token }),
    );
  }

  /** An assembly in progress is never aborted (spec §5). */
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

  /** One row per (session_id, number); a resend replaces it (spike test/spikes/upsert.test.ts). */
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

  /** Live blobs only: a part still being written stays 'writing' and discards itself when its commit fails (spec §4.1). */
  public async setSessionBlobsState(sessionId: string, kind: BlobKind, state: BlobState, now: DateTime): Promise<void> {
    await this.Driver.update().in(UPLOAD_BLOBS_TABLE).update({ state, updated_at: now }).where({ session_id: sessionId, kind, state: 'live' });
  }

  public async listBlobs(sessionId: string, state: BlobState): Promise<UploadBlob[]> {
    return await UploadBlob.query().ofSession(sessionId).inState(state);
  }

  public async deleteBlob(id: string): Promise<void> {
    await this.Driver.del().from(UPLOAD_BLOBS_TABLE).where({ id });
  }
}
