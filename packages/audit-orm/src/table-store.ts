import { AuditConfigError, AuditStore, AuditWriteFailed } from '@spinajs/audit';
import type { AuditAppend, AuditReader, TrailConfig } from '@spinajs/audit';
import { DI, Injectable } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

import { auditConnection, findConnection, insertRows, storedColumns } from './rows.js';
import { TableAuditReader } from './table-reader.js';

const quoted = (v: string): string => JSON.stringify(v);
// `instanceof` alone narrows to OrmDriver<any>.
const isDriver = (v: unknown): v is OrmDriver => v instanceof OrmDriver;

/**
 * A trail in a table: transactional events on the audited write's connection, every other event on the connection the write names, else the trail's.
 * A confirmed event joins a transaction the caller holds open on a driver that serves one transaction at a time: written
 * detached, it would wait for that transaction to end.
 */
@Injectable(AuditStore)
export class TableAuditStore extends AuditStore {
  override readonly joinsTransaction = true;

  override joinsCaller(trail: TrailConfig, connection: string | undefined): boolean {
    const driver = findConnection(connection ?? trail.connection);
    return driver !== undefined && driver.supportedFeatures().concurrentTransactions === false && driver.CurrentTransaction !== undefined;
  }

  async append(write: AuditAppend): Promise<void> {
    const driver = this.driverOf(write);
    const rows = write.events.map(storedColumns);
    try {
      // Only a joined confirmed write gets here inside a transaction it was not handed. The savepoint keeps a failed
      // insert from aborting the caller's transaction on Postgres.
      if (write.transaction === undefined && driver.CurrentTransaction !== undefined) await driver.transaction(() => insertRows(driver, write.trail.table, rows));
      else await insertRows(driver, write.trail.table, rows);
    } catch (err) {
      throw new AuditWriteFailed(`audit: recording ${write.events.length} event(s) of trail ${quoted(write.trail.name)} in ${write.trail.table} on connection ${quoted(driver.Options.Name)} failed; is the table migrated there (AuditTrailTableMigration)?`, err);
    }
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(DI.resolve(TableAuditReader));
  }

  private driverOf(write: AuditAppend): OrmDriver {
    const { trail, transaction } = write;
    if (transaction === undefined) return auditConnection(write.connection ?? trail.connection);
    if (!isDriver(transaction)) throw new AuditConfigError(`audit: TableAuditStore takes the OrmDriver of the audited write as the transaction of trail ${quoted(trail.name)}`);
    if (transaction.CurrentTransaction === undefined) throw new AuditWriteFailed(`audit: a transactional write to trail ${quoted(trail.name)} found no open transaction on connection ${quoted(transaction.Options.Name)}`);
    return transaction;
  }
}
