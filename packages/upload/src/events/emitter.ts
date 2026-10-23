import { Injectable, Singleton, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ev } from '@spinajs/queue';
import { DateTime } from 'luxon';

import type { UploadSession } from '../models/UploadSession.js';
import { UploadStore } from '../store.js';
import type { FinalEventName } from '../types.js';
import { isoOf } from '../view.js';
import { UploadAborted, UploadCompleted, UploadExpired, UploadFailed } from './events.js';
import type { UploadEvent } from './events.js';

function completedEventOf(session: UploadSession): UploadCompleted {
  return new UploadCompleted(session, {
    Sha256: session.sha256 ?? '',
    Mime: session.detected_mime ?? session.declared_mime ?? '',
    FileKey: session.file_key ?? '',
    CompletedAt: session.completed_at ? isoOf(session.completed_at) : '',
  });
}

/** The final event a row owes (final_event), built from the row alone, so the sweeper can emit it again. */
export function finalEventOf(session: UploadSession): UploadEvent | null {
  switch (session.final_event) {
    case 'UploadCompleted':
      return completedEventOf(session);
    case 'UploadFailed':
      return new UploadFailed(session, { Code: session.failure_code ?? '', Message: session.failure_message ?? '' });
    case 'UploadAborted':
      return new UploadAborted(session);
    case 'UploadExpired':
      return new UploadExpired(session, { ExpiresAt: isoOf(session.expires_at) });
    default:
      return null;
  }
}

@Singleton()
@Injectable()
export class UploadEvents {
  @Logger('upload')
  protected Log: Log;

  @Autoinject(UploadStore)
  protected Store: UploadStore;

  /** Stage events are best effort: a failed emit is logged and the request goes on. */
  public async stage(event: UploadEvent): Promise<void> {
    try {
      await ev(event);
    } catch (err) {
      this.Log.warn({ uploadId: event.UploadId, event: event.Name, error: err }, 'Upload ${uploadId}: event ${event} was not emitted');
    }
  }

  /**
   * Emits the final event the session owes and stamps final_event_at. false leaves it owed, for the sweeper to emit again;
   * consumers dedupe by UploadId (docs/upload/09-events.md).
   */
  public async final(session: UploadSession): Promise<boolean> {
    const event = finalEventOf(session);
    if (!event) return false;
    try {
      await ev(event);
    } catch (err) {
      this.Log.warn({ uploadId: session.id, event: event.Name, error: err }, 'Upload ${uploadId}: final event ${event} was not emitted; the sweeper emits it again');
      return false;
    }
    try {
      if (!(await this.Store.markFinalEmitted(session.id, event.Name as FinalEventName, DateTime.utc()))) {
        this.Log.debug({ uploadId: session.id, event: event.Name }, 'Upload ${uploadId}: final event ${event} was already recorded by another emit');
      }
    } catch (err) {
      this.Log.warn({ uploadId: session.id, event: event.Name, error: err }, 'Upload ${uploadId}: final event ${event} emitted but not recorded; it may be emitted again');
    }
    return true;
  }
}
