import './register-schema.js';

import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';

import { parseDuration, parsePositiveDuration } from './duration.js';
import { UploadEvents } from './events/emitter.js';
import { UploadAssemblyReleased, UploadPurged } from './events/events.js';
import { UploadBlob } from './models/UploadBlob.js';
import type { UploadSession } from './models/UploadSession.js';
import { UploadService } from './service.js';
import { UploadStorage } from './storage.js';
import type { ObjectRemoval } from './storage.js';
import { UploadStore } from './store.js';
import type { KeysetPage } from './store.js';
import type { UploadConfig } from './types.js';

/** What one sweep did; every count is of this run only. */
export interface SweepResult {
  /** Open sessions past expires_at that became expired. */
  expired: number;
  /** Stale assembling claims released. */
  released: number;
  /** Owed final events emitted again. */
  reemitted: number;
  /** Sessions purged after upload.sweeper.retainFinished. */
  purged: number;
  /** Objects removed together with their blob rows. */
  removedBlobs: number;
  /** Objects whose rm failed; their rows stay for the next run. */
  keptBlobs: number;
  /** Unexpected failures, each logged at error with its uploadId. */
  errors: number;
}

export interface SweepOptions {
  /** Checked before each batch: an aborted sweep stops early, and the next one goes on from the rows that are left. */
  readonly signal?: AbortSignal;
}

interface Removal {
  readonly removed: number;
  readonly kept: number;
}

type SweepItem = UploadSession | UploadBlob;

const emptyResult = (): SweepResult => ({ expired: 0, released: 0, reemitted: 0, purged: 0, removedBlobs: 0, keptBlobs: 0, errors: 0 });

const uploadIdOf = (item: SweepItem): string => (item instanceof UploadBlob ? item.session_id : item.id);

/**
 * Spec §9. Every change is a conditional UPDATE or DELETE, so a second sweep running at the same time (cron next to
 * the scheduler) only finds less to do, and a run after a clean one changes nothing. Objects are found through
 * upload_blobs only; storage is never listed (spec D13).
 */
@Singleton()
@Injectable()
export class UploadSweeper {
  @Config('upload')
  protected Options: UploadConfig;

  @Logger('upload')
  protected Log: Log;

  @Autoinject(UploadStore)
  protected Store: UploadStore;

  @Autoinject(UploadStorage)
  protected Storage: UploadStorage;

  @Autoinject(UploadService)
  protected Service: UploadService;

  @Autoinject(UploadEvents)
  protected Events: UploadEvents;

  public async sweep(options: SweepOptions = {}): Promise<SweepResult> {
    const result = emptyResult();
    const now = DateTime.utc();
    const staleBefore = now.minus(parsePositiveDuration(this.Options.assembly.staleAfter, 'upload.assembly.staleAfter'));
    const retainedBefore = now.minus(parseDuration(this.Options.sweeper.retainFinished, 'upload.sweeper.retainFinished'));
    const run = <T extends SweepItem>(read: (page: KeysetPage) => Promise<T[]>, handle: (item: T) => Promise<unknown>) => this.each(read, handle, result, options);

    // Leftovers first, so an object a later step fails to remove is tried once per run. Releases before expiry, so a
    // released session past expires_at expires in the same run; final events before the purge, which skips owed ones.
    await run((page) => this.Store.sweepableBlobs('garbage', null, page), (blob) => this.removeBlob(blob, result));
    await run((page) => this.Store.sweepableBlobs('writing', staleBefore, page), (blob) => this.reclaimWriting(blob, now, result));
    await run((page) => this.Store.staleClaims(staleBefore, page), (session) => this.release(session, now, result));
    await run((page) => this.Store.openExpiredBy(now, page), (session) => this.expire(session, result));
    await run((page) => this.Store.owedFinalEvents(staleBefore, page), (session) => this.reemit(session, result));
    await run((page) => this.Store.retainedCompleted(retainedBefore, page), (session) => this.purgeParts(session, now, result));
    await run((page) => this.Store.retainedFinished(retainedBefore, page), (session) => this.purgeSession(session, now, result));

    this.Log.info(
      { ...result },
      'Upload sweep: ${expired} expired, ${released} released, ${reemitted} re-emitted, ${purged} purged, ${removedBlobs} objects removed, ${keptBlobs} kept, ${errors} errors',
    );
    return result;
  }

  /** Keyset pages: a row that stays (a failed rm) sorts before the next page, so the run never reads it twice. */
  private async each<T extends SweepItem>(read: (page: KeysetPage) => Promise<T[]>, handle: (item: T) => Promise<unknown>, result: SweepResult, options: SweepOptions): Promise<void> {
    const limit = this.Options.sweeper.batch;
    let after = '';
    while (options.signal?.aborted !== true) {
      const items = await read({ after, limit });
      for (const item of items) await this.guarded(item, handle, result);
      if (items.length < limit) return;
      after = items[items.length - 1].id;
    }
  }

  private async guarded<T extends SweepItem>(item: T, handle: (item: T) => Promise<unknown>, result: SweepResult): Promise<void> {
    try {
      await handle(item);
    } catch (err) {
      result.errors++;
      this.Log.error({ uploadId: uploadIdOf(item), error: err }, 'Upload ${uploadId}: the sweep failed on it; the next run tries again');
    }
  }

  private async removeBlob(blob: UploadBlob, result: SweepResult): Promise<ObjectRemoval> {
    const removal = await this.Storage.removeObject(blob.id, blob.fs, blob.key, blob.session_id);
    if (removal === 'removed') result.removedBlobs++;
    else if (removal === 'kept') result.keptBlobs++;
    return removal;
  }

  /** Only while the row is still 'writing': a blob that went live since the read is a committed part or file. */
  private async reclaimWriting(blob: UploadBlob, now: DateTime, result: SweepResult): Promise<void> {
    if (await this.Store.setBlobState(blob.id, 'writing', 'garbage', now)) await this.removeBlob(blob, result);
  }

  private async removeGarbageOf(sessionId: string, result: SweepResult): Promise<Removal> {
    let removed = 0;
    let kept = 0;
    for (const blob of await this.Store.listBlobs(sessionId, 'garbage')) {
      const removal = await this.removeBlob(blob, result);
      if (removal === 'removed') removed++;
      else if (removal === 'kept') kept++;
    }
    return { removed, kept };
  }

  /** Spec §9 step 2. The partial target is the session's 'writing' file blob; its request lost the claim with the release. */
  private async release(session: UploadSession, now: DateTime, result: SweepResult): Promise<void> {
    const claim = session.claim_token;
    if (claim === null) return;
    const released = await this.Store.transaction(async () => {
      if (!(await this.Store.release(session.id, claim, now))) return false;
      for (const blob of await this.Store.listBlobs(session.id, 'writing')) {
        if (blob.kind === 'file') await this.Store.setBlobState(blob.id, 'writing', 'garbage', now);
      }
      return true;
    });
    if (!released) return;
    result.released++;
    this.Log.warn({ uploadId: session.id }, 'Upload ${uploadId}: stale claim released by the sweeper');
    // Staged before the removal: a failure there must not lose the event.
    await this.Events.stage(new UploadAssemblyReleased(await this.Store.requireSession(session.id), { Reason: 'stale' }));
    await this.removeGarbageOf(session.id, result);
  }

  /** Spec §9 step 1. UploadService.expire emits UploadExpired and logs; it keeps the parts, which go here. */
  private async expire(session: UploadSession, result: SweepResult): Promise<void> {
    if (!(await this.Service.expire(session))) return;
    result.expired++;
    await this.Store.dropParts(session.id, DateTime.utc());
    await this.removeGarbageOf(session.id, result);
  }

  /** Spec §9 step 5. Events.final emits, then stamps final_event_at; false leaves the event owed for the next run. */
  private async reemit(session: UploadSession, result: SweepResult): Promise<void> {
    if (!(await this.Events.final(session))) return;
    result.reemitted++;
    this.Log.warn({ uploadId: session.id, event: session.final_event }, 'Upload ${uploadId}: final event ${event} re-emitted by the sweeper');
  }

  /** Spec §9 step 3 for a completed session: its parts go, its row and merged file stay. */
  private async purgeParts(session: UploadSession, now: DateTime, result: SweepResult): Promise<void> {
    if (!(await this.Store.dropParts(session.id, now))) return;
    const { removed } = await this.removeGarbageOf(session.id, result);
    if (!this.fileUnderPrefix(session)) await this.Storage.removePrefix(session.temp_fs, session.id);
    await this.purged(session, removed, result);
  }

  /** Spec §9 step 3 for a failed, aborted or expired session: everything goes, the row last, once no object is left. */
  private async purgeSession(session: UploadSession, now: DateTime, result: SweepResult): Promise<void> {
    // A session expired by UploadService.expire outside a sweep still has its parts.
    await this.Store.dropParts(session.id, now);
    await this.Store.abandonBlobs(session.id, now);
    const { removed, kept } = await this.removeGarbageOf(session.id, result);
    if (kept > 0) return;
    await this.Storage.removePrefix(session.temp_fs, session.id);
    if (await this.Store.deleteFinishedSession(session.id)) await this.purged(session, removed, result);
  }

  /** An app's fileDir may put the merged file under the session prefix; one rm of the prefix would take it too. */
  private fileUnderPrefix(session: UploadSession): boolean {
    if (!this.Storage.isValidSessionId(session.id)) {
      this.Log.warn({ uploadId: session.id }, 'Upload ${uploadId}: the session id is not a valid folder name, its prefix is not removed');
      return true;
    }
    return session.file_key !== null && session.file_key.startsWith(`${this.Storage.sessionPrefix(session.id)}/`);
  }

  private async purged(session: UploadSession, blobs: number, result: SweepResult): Promise<void> {
    result.purged++;
    this.Log.info({ uploadId: session.id, owner: session.owner, status: session.status, blobs }, 'Upload ${uploadId} purged');
    await this.Events.stage(new UploadPurged(session, { Blobs: blobs }));
  }
}
