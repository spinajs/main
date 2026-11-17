import type { AuditEvent, AuditSubject } from '@spinajs/audit';
import type { OrmDriver } from '@spinajs/orm';

import { REDACTED_DATA, insertRows, rowsOf, storedColumns, toStored } from '../rows.js';
import { AUDIT_OUTBOX_TABLE } from './table.js';

export interface BufferedEvent {
  readonly seq: number;
  /** The payload was already blanked when the shipper read the row. */
  readonly blank: boolean;
  readonly event: AuditEvent;
}

export async function bufferEvents(driver: OrmDriver, trail: string, events: readonly AuditEvent[]): Promise<void> {
  await insertRows(
    driver,
    AUDIT_OUTBOX_TABLE,
    events.map((e) => ({ trail, ...storedColumns(e) })),
  );
}

/** The oldest buffered events of one trail, in buffer order. */
export async function oldestBuffered(driver: OrmDriver, trail: string, limit: number): Promise<BufferedEvent[]> {
  const rows = rowsOf(await driver.select().from(AUDIT_OUTBOX_TABLE).where('trail', trail).orderBy('seq').take(limit));
  return rows.map((row) => {
    const { seq, redacted, ...event } = toStored(row);
    return { seq, blank: redacted, event };
  });
}

/**
 * Deletes a delivered batch by `seq` and `id`. A row blanked while it was delivered no longer matches the guarded delete:
 * it is removed apart and its subject returned, because the destination got the payload that erasure removed.
 */
export async function removeBuffered(driver: OrmDriver, batch: readonly BufferedEvent[]): Promise<AuditSubject[]> {
  const seqs = batch.map((b) => b.seq);
  const ids = batch.map((b) => b.event.id);
  await driver.del().from(AUDIT_OUTBOX_TABLE).whereIn('seq', seqs).whereIn('id', ids).where('data', '<>', REDACTED_DATA);
  // Left: rows already blank when they were read, and rows blanked during the delivery.
  const left = rowsOf(await driver.select().from(AUDIT_OUTBOX_TABLE).whereIn('seq', seqs).whereIn('id', ids)).map(toStored);
  if (left.length > 0) await driver.del().from(AUDIT_OUTBOX_TABLE).whereIn('seq', seqs).whereIn('id', ids);
  const readFull = new Set(batch.filter((b) => !b.blank).map((b) => b.seq));
  return left.flatMap((e) => (readFull.has(e.seq) && e.subject !== undefined ? [e.subject] : []));
}

/** Blanks the payload of one subject's buffered events; returns how many this call blanked. */
export async function blankBuffered(driver: OrmDriver, trail: string, subject: AuditSubject): Promise<number> {
  const { RowsAffected } = await driver.update().in(AUDIT_OUTBOX_TABLE).update({ data: REDACTED_DATA }).where('trail', trail).where('subject_type', subject.type).where('subject_id', subject.id).where('data', '<>', REDACTED_DATA);
  return RowsAffected;
}
