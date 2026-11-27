import type { ResourceType } from '@spinajs/authz';
import { IdentifierQuoter } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { tableOf } from '../ids.js';
import { classesOf, typesAbove } from '../registry.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';

/**
 * The first statements of a rebuild's transaction, before it reads: until it commits, no write of the tables the rebuild of
 * `type` reads and no write of authz_resource_ancestor runs; readers go on. The resource tables come first, in name order,
 * because an application's write takes its resource table before the observer writes the ancestor table: the other order
 * deadlocks with a move in flight.
 */
export async function lockForRebuild(driver: OrmDriver, type: ResourceType): Promise<void> {
  const tables = new Set([type, ...typesAbove(type)].flatMap((t) => classesOf(t).map(tableOf)));
  for (const table of [...tables].sort()) await driver.lockTableShared(table);
  await lockAncestorTable(driver);
}

async function lockAncestorTable(driver: OrmDriver): Promise<void> {
  const dialect = driver.Options.Driver;
  if (dialect !== 'orm-driver-postgres' && dialect !== 'orm-driver-pglite') return driver.lockTableShared(AUTHZ_RESOURCE_ANCESTOR_TABLE);
  // SHARE (lockTableShared) is not self-exclusive: two rebuilds would both hold it and deadlock on their DELETEs.
  await driver.schema().raw(`LOCK TABLE ${driver.Container.resolve(IdentifierQuoter).quoteQualified(AUTHZ_RESOURCE_ANCESTOR_TABLE)} IN SHARE ROW EXCLUSIVE MODE`);
}
