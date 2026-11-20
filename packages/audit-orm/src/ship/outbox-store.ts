import { AuditConfigError, AuditNotSupported, AuditReader, AuditStore, AuditWriteFailed } from '@spinajs/audit';
import type { AuditAppend, AuditFilter, AuditPinnedHead, AuditSubject, AuditVerifyReport, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';

import { insertForWrite, joinsCallerOn, quoted, writeDriver } from '../orm-store.js';
import { auditConnection } from '../rows.js';
import { blankBuffered, bufferRows } from './outbox.js';
import { distinctConnections, namedService } from './services.js';
import { AUDIT_OUTBOX_TABLE, AUDIT_TRAIL_WIDTH } from './table.js';

/**
 * Reads a shipping trail where its sink put it. Events still in the buffer are not merged in: a read sees an event
 * once it was shipped. An erasure also blanks what is still buffered: on `source`, or without one on every connection that
 * buffers, because transactional events are buffered on the connection of each audited write.
 */
export class ShippedAuditReader extends AuditReader {
  constructor(private readonly shipped: AuditReader) {
    super();
  }

  list(trail: TrailConfig, filter: AuditFilter): Promise<readonly StoredAuditEvent[]> {
    return this.shipped.list(trail, filter);
  }

  async redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    let pending = 0;
    for (const driver of source === undefined ? distinctConnections() : [auditConnection(source)]) {
      if (await driver.schema().tableExists(AUDIT_OUTBOX_TABLE)) pending += await blankBuffered(driver, trail.name, subject);
    }
    return pending + (await this.shipped.redact(trail, subject, source));
  }

  prune(trail: TrailConfig, before: Date, source?: string): Promise<number> {
    return this.shipped.prune(trail, before, source);
  }

  async verify(trail: TrailConfig, source?: string, pinned?: AuditPinnedHead): Promise<AuditVerifyReport> {
    if (!this.shipped.verify) throw new AuditNotSupported(`audit: the reader ${this.shipped.constructor.name} of trail ${quoted(trail.name)} cannot verify seals`);
    return this.shipped.verify(trail, source, pinned);
  }
}

/**
 * A trail in the buffer table: transactional events on the audited write's connection, every other event on the connection the write names, else the trail's.
 * A confirmed event joins a transaction the caller holds open on a driver that serves one transaction at a time, as in TableAuditStore.
 */
@Injectable(AuditStore)
export class OutboxAuditStore extends AuditStore {
  override readonly joinsTransaction = true;

  override joinsCaller(trail: TrailConfig, connection: string | undefined): boolean {
    return joinsCallerOn(trail, connection);
  }

  async append(write: AuditAppend): Promise<void> {
    const { trail, events } = write;
    if (trail.name.length > AUDIT_TRAIL_WIDTH) throw new AuditConfigError(`audit: trail name ${quoted(trail.name)} is longer than ${AUDIT_TRAIL_WIDTH} characters and cannot be buffered`);
    const driver = writeDriver(write, 'OutboxAuditStore');
    try {
      await insertForWrite(driver, write, AUDIT_OUTBOX_TABLE, bufferRows(trail.name, events));
    } catch (err) {
      if (err instanceof AuditWriteFailed) throw err;
      throw new AuditWriteFailed(`audit: buffering ${events.length} event(s) of trail ${quoted(trail.name)} in ${AUDIT_OUTBOX_TABLE} on connection ${quoted(driver.Options.Name)} failed; is the table migrated there (AuditOutboxTableMigration)?`, err);
    }
  }

  async reader(trail: TrailConfig): Promise<AuditReader | undefined> {
    if (trail.reader === undefined) return undefined;
    return new ShippedAuditReader(await namedService(AuditReader, trail.reader, `audit.trails.${trail.name}.reader`));
  }
}
