import { AuditStore, AuditWriteFailed } from '@spinajs/audit';
import type { AuditAppend, AuditReader, TrailConfig } from '@spinajs/audit';
import { DI, Injectable } from '@spinajs/di';

import { insertForWrite, joinsCallerOn, quoted, writeDriver } from './orm-store.js';
import { storedColumns } from './rows.js';
import { TableAuditReader } from './table-reader.js';

/**
 * A trail in a table: transactional events on the audited write's connection, every other event on the connection the write names, else the trail's.
 * A confirmed event joins a transaction the caller holds open on a driver that serves one transaction at a time: written
 * detached, it would wait for that transaction to end.
 */
@Injectable(AuditStore)
export class TableAuditStore extends AuditStore {
  override readonly joinsTransaction = true;

  override joinsCaller(trail: TrailConfig, connection: string | undefined): boolean {
    return joinsCallerOn(trail, connection);
  }

  async append(write: AuditAppend): Promise<void> {
    const driver = writeDriver(write, 'TableAuditStore');
    try {
      await insertForWrite(driver, write, write.trail.table, write.events.map(storedColumns));
    } catch (err) {
      if (err instanceof AuditWriteFailed) throw err;
      throw new AuditWriteFailed(`audit: recording ${write.events.length} event(s) of trail ${quoted(write.trail.name)} in ${write.trail.table} on connection ${quoted(driver.Options.Name)} failed; is the table migrated there (AuditTrailTableMigration)?`, err);
    }
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(DI.resolve(TableAuditReader));
  }
}
