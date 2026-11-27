import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import { IdentifierQuoter, OrmException } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { tableOf } from '../ids.js';
import { classesOf, typesAbove } from '../registry.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';

/** How long a rebuild waits on PostgreSQL for one lock. Package-internal; tests shorten it. */
export const REBUILD_LOCK_WAIT = { seconds: 5 };

const isPostgres = (driver: OrmDriver): boolean => driver.Options.Driver === 'orm-driver-postgres' || driver.Options.Driver === 'orm-driver-pglite';

const lockNotAvailable = (e: unknown): boolean => e instanceof OrmException && typeof e.inner === 'object' && e.inner !== null && 'code' in e.inner && e.inner.code === '55P03';

/** `e` as the rebuild's own error when PostgreSQL's lock timeout ended the type's transaction: at a table lock, or at a row lock of its DELETE. */
export function rebuildLockError(type: ResourceType, e: unknown): unknown {
  if (!lockNotAvailable(e)) return e;
  return new AuthzConfigError(`${type}: could not lock the tables of the rebuild within ${REBUILD_LOCK_WAIT.seconds} s: a transaction is writing them, or another rebuild is running; nothing of ${type} was changed; run the rebuild again when it has ended`);
}

/**
 * The first statements of a rebuild's transaction, before it reads: until it commits, no write of the tables the rebuild of
 * `type` reads and no write of authz_resource_ancestor runs; readers go on. The resource tables come first, because an
 * application's write takes its resource table before the observer writes the ancestor table: the other order deadlocks
 * with a move in flight. They come in name order, one order for every rebuild, so two rebuilds of different types never
 * lock the same tables in opposite orders (MySQL locks them exclusively).
 */
export async function lockForRebuild(driver: OrmDriver, type: ResourceType): Promise<void> {
  const tables = new Set([type, ...typesAbove(type)].flatMap((t) => classesOf(t).map(tableOf)));
  const postgres = isPostgres(driver);
  // A rebuild waiting in PostgreSQL's lock queue holds back every writer queued behind it, for as long as the transaction it waits for stays open.
  if (postgres) await driver.schema().raw(`SET LOCAL lock_timeout = '${Number(REBUILD_LOCK_WAIT.seconds)}s'`);
  for (const table of [...tables].sort()) await driver.lockTableShared(table);
  await lockAncestorTable(driver, postgres);
}

async function lockAncestorTable(driver: OrmDriver, postgres: boolean): Promise<void> {
  if (!postgres) return driver.lockTableShared(AUTHZ_RESOURCE_ANCESTOR_TABLE);
  // SHARE (lockTableShared) is not self-exclusive: two rebuilds would both hold it and deadlock on their DELETEs.
  await driver.schema().raw(`LOCK TABLE ${driver.Container.resolve(IdentifierQuoter).quoteQualified(AUTHZ_RESOURCE_ANCESTOR_TABLE)} IN SHARE ROW EXCLUSIVE MODE`);
}
