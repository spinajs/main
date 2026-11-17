import type { AuditEvent, AuditSubject } from '@spinajs/audit';
import type { OrmDriver } from '@spinajs/orm';

import { REDACTED_DATA, insertRows, rowsOf, storedColumns, toStored } from '../rows.js';
import { AUDIT_OUTBOX_TABLE } from './table.js';

export interface BufferedEvent {
  readonly seq: number;
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
    // The buffer's seq and its redaction flag mean nothing to a sink.
    const { seq, redacted: _redacted, ...event } = toStored(row);
    return { seq, event };
  });
}

export async function removeBuffered(driver: OrmDriver, seqs: readonly number[]): Promise<void> {
  await driver
    .del()
    .from(AUDIT_OUTBOX_TABLE)
    .whereIn('seq', [...seqs]);
}

/** Blanks the payload of one subject's buffered events; returns how many this call blanked. */
export async function blankBuffered(driver: OrmDriver, trail: string, subject: AuditSubject): Promise<number> {
  const { RowsAffected } = await driver.update().in(AUDIT_OUTBOX_TABLE).update({ data: REDACTED_DATA }).where('trail', trail).where('subject_type', subject.type).where('subject_id', subject.id).where('data', '<>', REDACTED_DATA);
  return RowsAffected;
}
