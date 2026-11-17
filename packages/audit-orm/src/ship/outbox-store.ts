import { AuditConfigError, AuditReader, AuditStore, AuditWriteFailed } from '@spinajs/audit';
import type { AuditAppend, AuditFilter, AuditSubject, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

import { auditConnection } from '../rows.js';
import { blankBuffered, bufferEvents } from './outbox.js';
import { namedService } from './services.js';
import { AUDIT_OUTBOX_TABLE, AUDIT_TRAIL_WIDTH } from './table.js';

const quoted = (v: string): string => JSON.stringify(v);
// `instanceof` alone narrows to OrmDriver<any>.
const isDriver = (v: unknown): v is OrmDriver => v instanceof OrmDriver;

/**
 * Reads a shipping trail where its sink put it. Events still in the buffer are not merged in: a read sees an event
 * once it was shipped. An erasure also blanks what is still buffered.
 */
export class ShippedAuditReader extends AuditReader {
  constructor(private readonly shipped: AuditReader) {
    super();
  }

  list(trail: TrailConfig, filter: AuditFilter): Promise<readonly StoredAuditEvent[]> {
    return this.shipped.list(trail, filter);
  }

  async redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    const pending = await blankBuffered(auditConnection(source ?? trail.connection), trail.name, subject);
    return pending + (await this.shipped.redact(trail, subject, source));
  }

  prune(trail: TrailConfig, before: Date, source?: string): Promise<number> {
    return this.shipped.prune(trail, before, source);
  }
}

/** A trail in the buffer table: transactional events on the audited write's connection, every other event on the connection the write names, else the trail's. */
@Injectable(AuditStore)
export class OutboxAuditStore extends AuditStore {
  override readonly joinsTransaction = true;

  async append(write: AuditAppend): Promise<void> {
    const { trail, events } = write;
    if (trail.name.length > AUDIT_TRAIL_WIDTH) throw new AuditConfigError(`audit: trail name ${quoted(trail.name)} is longer than ${AUDIT_TRAIL_WIDTH} characters and cannot be buffered`);
    const driver = this.driverOf(write);
    try {
      await bufferEvents(driver, trail.name, events);
    } catch (err) {
      throw new AuditWriteFailed(`audit: buffering ${events.length} event(s) of trail ${quoted(trail.name)} in ${AUDIT_OUTBOX_TABLE} on connection ${quoted(driver.Options.Name)} failed; is the table migrated there (AuditOutboxTableMigration)?`, err);
    }
  }

  async reader(trail: TrailConfig): Promise<AuditReader | undefined> {
    if (trail.reader === undefined) return undefined;
    return new ShippedAuditReader(await namedService(AuditReader, trail.reader, `audit.trails.${trail.name}.reader`));
  }

  private driverOf(write: AuditAppend): OrmDriver {
    const { trail, transaction } = write;
    if (transaction === undefined) return auditConnection(write.connection ?? trail.connection);
    if (!isDriver(transaction)) throw new AuditConfigError(`audit: OutboxAuditStore takes the OrmDriver of the audited write as the transaction of trail ${quoted(trail.name)}`);
    if (transaction.CurrentTransaction === undefined) throw new AuditWriteFailed(`audit: a transactional write to trail ${quoted(trail.name)} found no open transaction on connection ${quoted(transaction.Options.Name)}`);
    return transaction;
  }
}
