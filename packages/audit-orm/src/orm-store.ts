import { AuditConfigError, AuditWriteFailed } from '@spinajs/audit';
import type { AuditAppend, TrailConfig } from '@spinajs/audit';
import { OrmDriver } from '@spinajs/orm';

import { auditConnection, findConnection, insertRows } from './rows.js';

// What the stores of this package that write through the ORM share for a write.

export const quoted = (v: string): string => JSON.stringify(v);
// `instanceof` alone narrows to OrmDriver<any>.
const isDriver = (v: unknown): v is OrmDriver => v instanceof OrmDriver;

/** The driver a write goes to: the handed one for a transactional write (`store` names the store in its errors), else the connection the write names, else the trail's. */
export function writeDriver(write: AuditAppend, store: string): OrmDriver {
  const { trail, transaction } = write;
  if (transaction === undefined) return auditConnection(write.connection ?? trail.connection);
  if (!isDriver(transaction)) throw new AuditConfigError(`audit: ${store} takes the OrmDriver of the audited write as the transaction of trail ${quoted(trail.name)}`);
  if (transaction.CurrentTransaction === undefined) throw new AuditWriteFailed(`audit: a transactional write to trail ${quoted(trail.name)} found no open transaction on connection ${quoted(transaction.Options.Name)}`);
  return transaction;
}

/** `AuditStore.joinsCaller`: a driver that serves one transaction at a time, with one open in the caller's async context. Never throws. */
export function joinsCallerOn(trail: TrailConfig, connection: string | undefined): boolean {
  const driver = findConnection(connection ?? trail.connection);
  return driver !== undefined && driver.supportedFeatures().concurrentTransactions === false && driver.CurrentTransaction !== undefined;
}

/**
 * Inserts the rows of `write` into `table` on `driver`. Inside a transaction the write was not handed (a joined confirmed
 * write) the insert runs in a savepoint, which takes its turn with the other savepoints of that transaction. An error of
 * the insert itself passes through as it is; a failure of the savepoint is an `AuditWriteFailed` of its own.
 */
export function insertForWrite(driver: OrmDriver, write: AuditAppend, table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  // A chain of joined writes of our own would deadlock against the ORM's turn queue: a record inside a nested
  // transaction would wait for one queued behind that transaction's savepoint. Whatever audits builder writes must
  // leave trail tables out, or each joined insert raises another one.
  if (write.transaction !== undefined || driver.CurrentTransaction === undefined) return insertRows(driver, table, rows);
  return inSavepoint(driver, write, table, rows);
}

// The savepoint keeps a failed insert from aborting the caller's transaction on Postgres.
async function inSavepoint(driver: OrmDriver, write: AuditAppend, table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  const step: { inside: boolean; failure?: unknown } = { inside: false };
  try {
    await driver.transaction(async () => {
      step.inside = true;
      await insertRows(driver, table, rows).catch((err: unknown) => {
        step.failure = err;
        throw err;
      });
    });
  } catch (err) {
    if (step.inside && err === step.failure) throw err;
    const failed = `audit: recording ${write.events.length} event(s) of trail ${quoted(write.trail.name)} on connection ${quoted(driver.Options.Name)} failed at its savepoint in the caller's transaction`;
    throw new AuditWriteFailed(step.inside ? `${failed}; that transaction may be unusable` : failed, err);
  }
}
