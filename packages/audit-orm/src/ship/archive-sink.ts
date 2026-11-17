import { AuditConfigError, AuditEventSink, trailConfig } from '@spinajs/audit';
import type { AuditBatch, AuditEvent } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import type { OrmDriver } from '@spinajs/orm';

import { insertRows, rowsOf, storedColumns } from '../rows.js';
import { archiveDriver } from './archive.js';
import { AUDIT_SOURCE_WIDTH } from './table.js';

// Keeps the id list of one dedup select under the bind limit of every driver (MSSQL 2100; SQLite 32766 since 3.32).
const ID_CHUNK = 500;
// A delivery of the same events running beside this one (an abandoned delivery landing late, a second shipper) can commit
// between our select and our insert: the unique index on id refuses ours, and the next attempt finds those ids stored.
const ATTEMPTS = 3;

async function storeNew(driver: OrmDriver, table: string, source: string, events: readonly AuditEvent[]): Promise<number> {
  let stored = 0;
  // spinajs-orm-ignore ORM102: deliberate batching, one SELECT and one INSERT per ID_CHUNK events
  for (let i = 0; i < events.length; i += ID_CHUNK) {
    const chunk = events.slice(i, i + ID_CHUNK);
    const present = rowsOf(
      await driver
        .select()
        .from(table)
        .columns(['id'])
        .whereIn(
          'id',
          chunk.map((e) => e.id),
        ),
    );
    // Also catches an id repeated inside one batch.
    const known = new Set<unknown>(present.map((r) => r.id));
    const rows: Record<string, unknown>[] = [];
    for (const e of chunk) {
      if (known.has(e.id)) continue;
      known.add(e.id);
      rows.push({ source, ...storedColumns(e) });
    }
    await insertRows(driver, table, rows);
    stored += rows.length;
  }
  return stored;
}

/** Stores `events` in an archive table once per id; returns how many were new. */
export async function archiveEvents(driver: OrmDriver, table: string, source: string, events: readonly AuditEvent[]): Promise<number> {
  if (source.length > AUDIT_SOURCE_WIDTH) throw new AuditConfigError(`audit: source connection name ${JSON.stringify(source)} is longer than ${AUDIT_SOURCE_WIDTH} characters and cannot be archived`);
  if (events.length === 0) return 0;
  // Inside a transaction the caller holds open, the rows commit with it: a savepoint of ours there could interleave with the caller's.
  if (driver.CurrentTransaction !== undefined) return storeNew(driver, table, source, events);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await driver.transaction(() => storeNew(driver, table, source, events));
    } catch (err) {
      if (attempt >= ATTEMPTS) throw new InvalidOperation(`audit: archiving ${events.length} event(s) in table ${JSON.stringify(table)} on connection ${JSON.stringify(driver.Options.Name)} failed after ${ATTEMPTS} attempts`, err);
    }
  }
}

const hasTable = (driver: OrmDriver, table: string): Promise<boolean> =>
  driver
    .schema()
    .tableExists(table)
    .catch(() => true);

/** Stores a shipped batch in the trail's `table` on its `archiveConnection`, once per event id. */
@Injectable(AuditEventSink)
export class ArchiveAuditSink extends AuditEventSink {
  async deliver(batch: AuditBatch): Promise<void> {
    const trail = trailConfig(batch.trail);
    const driver = archiveDriver(trail);
    try {
      await archiveEvents(driver, trail.table, batch.source, batch.events);
    } catch (err) {
      if (err instanceof AuditConfigError || (await hasTable(driver, trail.table))) throw err;
      throw new InvalidOperation(`audit: archiving trail ${JSON.stringify(trail.name)} failed; is ${JSON.stringify(trail.table)} migrated on its archive connection (AuditArchiveTableMigration)?`, err);
    }
  }
}
