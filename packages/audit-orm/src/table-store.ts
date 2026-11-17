import { AuditConfigError, AuditStore, AuditWriteFailed, auditStore, trailConfig, trailNames } from '@spinajs/audit';
import type { AuditAppend, AuditReader, TrailConfig } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

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
    await assertOwnTables();
    const driver = writeDriver(write, 'TableAuditStore');
    try {
      await insertForWrite(driver, write, write.trail.table, write.events.map(storedColumns));
    } catch (err) {
      if (err instanceof AuditWriteFailed) throw err;
      throw new AuditWriteFailed(`audit: recording ${write.events.length} event(s) of trail ${quoted(write.trail.name)} in ${write.trail.table} on connection ${quoted(driver.Options.Name)} failed; is the table migrated there (AuditTrailTableMigration)?`, err);
    }
  }

  async reader(): Promise<AuditReader | undefined> {
    await assertOwnTables();
    return DI.resolve(TableAuditReader);
  }
}

// The `audit.trails` values already found free of shared tables; a changed configuration is a new value.
const checked = new WeakSet<object>();

const driverName = (connection: string): string => DI.get(Orm)?.Connections.get(connection)?.Options.Name ?? connection;

function configOf(name: string): TrailConfig | undefined {
  try {
    return trailConfig(name);
  } catch {
    // An invalid trail fails where it is used, not on every other trail.
    return undefined;
  }
}

/**
 * Refuses two trails of a table store on one table and connection (design D10): a trail table has no trail column, so
 * retention and reads of one trail would reach the other's events. Checked once per `audit.trails` value.
 */
export async function assertOwnTables(): Promise<void> {
  const configured: unknown = DI.get(Configuration)?.get<unknown>(['audit', 'trails']);
  if (configured === null || typeof configured !== 'object' || checked.has(configured)) return;
  const registered = DI.RootContainer.getRegisteredNames(AuditStore);
  const owners = new Map<string, string>();
  for (const name of trailNames()) {
    const trail = configOf(name);
    if (trail === undefined || !registered.includes(trail.store) || !((await auditStore(trail)) instanceof TableAuditStore)) continue;
    const connection = driverName(trail.connection);
    const key = JSON.stringify([connection, trail.table]);
    const other = owners.get(key);
    if (other !== undefined) throw new AuditConfigError(`audit: trails ${quoted(other)} and ${quoted(name)} both use table ${quoted(trail.table)} on connection ${quoted(connection)}; give each trail its own table`);
    owners.set(key, name);
  }
  checked.add(configured);
}
