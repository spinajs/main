import type { AuditEvent, AuditSubject, StoredAuditEvent } from '@spinajs/audit';
import type { OrmDriver } from '@spinajs/orm';

import { REDACTED_DATA, exceptErasureRecords, rowsOf, storedColumns, toStored } from '../rows.js';
import { AUDIT_OUTBOX_TABLE } from './table.js';

export interface BufferedEvent {
  readonly seq: number;
  readonly event: AuditEvent;
}

/** The buffer rows of a trail's events. */
export function bufferRows(trail: string, events: readonly AuditEvent[]): Record<string, unknown>[] {
  return events.map((e) => ({ trail, ...storedColumns(e) }));
}

/** The oldest buffered events of one trail, in buffer order. */
export async function oldestBuffered(driver: OrmDriver, trail: string, limit: number): Promise<BufferedEvent[]> {
  const rows = rowsOf(await driver.select().from(AUDIT_OUTBOX_TABLE).where('trail', trail).orderBy('seq').take(limit));
  return rows.map((row) => {
    const { seq, redacted: _redacted, ...event } = toStored(row);
    return { seq, event };
  });
}

/**
 * Deletes the rows of a delivered batch that still hold their payload, by `seq` and `id`, and returns the others: rows an
 * erasure blanked before or during the delivery. An earlier delivery of them may have landed late with the payload, so
 * the caller redacts the destination before it removes them with `removeBlank`.
 */
export async function removeBuffered(driver: OrmDriver, batch: readonly BufferedEvent[]): Promise<StoredAuditEvent[]> {
  const seqs = batch.map((b) => b.seq);
  const ids = batch.map((b) => b.event.id);
  await driver.del().from(AUDIT_OUTBOX_TABLE).whereIn('seq', seqs).whereIn('id', ids).where('data', '<>', REDACTED_DATA);
  return rowsOf(await driver.select().from(AUDIT_OUTBOX_TABLE).whereIn('seq', seqs).whereIn('id', ids)).map(toStored);
}

export async function removeBlank(driver: OrmDriver, rows: readonly StoredAuditEvent[]): Promise<void> {
  if (rows.length === 0) return;
  await driver
    .del()
    .from(AUDIT_OUTBOX_TABLE)
    .whereIn(
      'seq',
      rows.map((r) => r.seq),
    )
    .whereIn(
      'id',
      rows.map((r) => r.id),
    );
}

/** Blanks the payload of one subject's buffered events; returns how many this call blanked. */
export async function blankBuffered(driver: OrmDriver, trail: string, subject: AuditSubject): Promise<number> {
  const { RowsAffected } = await driver.update().in(AUDIT_OUTBOX_TABLE).update({ data: REDACTED_DATA }).where('trail', trail).where('subject_type', subject.type).where('subject_id', subject.id).where(exceptErasureRecords).where('data', '<>', REDACTED_DATA);
  return RowsAffected;
}
