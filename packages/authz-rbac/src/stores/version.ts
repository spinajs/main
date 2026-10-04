import { IdentifierQuoter, OrmDriver } from '@spinajs/orm';

import { transactionDriver } from './context.js';

export const AUTHZ_VERSION_TABLE = 'authz_version';

/**
 * `authz_version(domain) += 1` inside the caller's transaction, creating the row at 1 (D-L2-3).
 * The increment is one statement, so concurrent writers never lose a bump; the update builder
 * cannot express `version = version + 1`, hence the raw statement.
 */
export async function bumpVersion(driver: OrmDriver, domain: string): Promise<void> {
  transactionDriver({ driver }, 'bumpVersion');

  await driver.insert().into(AUTHZ_VERSION_TABLE).values({ domain, version: 0 }).orIgnore();

  const q = driver.Container.resolve(IdentifierQuoter);
  const [table, version, key] = [q.quote(AUTHZ_VERSION_TABLE), q.quote('version'), q.quote('domain')];
  await driver.schema().raw(`UPDATE ${table} SET ${version} = ${version} + 1 WHERE ${key} = ?`, [domain]);
}

/** The domain's version as text (Postgres returns bigint as a string); `'0'` when the row is absent. */
export async function readVersion(driver: OrmDriver, domain: string): Promise<string> {
  const rows = (await driver.select().from(AUTHZ_VERSION_TABLE).where('domain', domain)) as { version: unknown }[];
  return rows.length === 0 ? '0' : String(rows[0].version);
}
