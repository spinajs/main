import { OrmDriver, bumpVersionRow } from '@spinajs/orm';

import { transactionDriver } from './context.js';

export const AUTHZ_VERSION_TABLE = 'authz_version';

/** `authz_version(domain) += 1` inside the caller's transaction, creating the row at 1 (D-L2-3). */
export async function bumpVersion(driver: OrmDriver, domain: string): Promise<void> {
  transactionDriver({ driver }, 'bumpVersion');
  await bumpVersionRow(driver, AUTHZ_VERSION_TABLE, { domain });
}

/** The domain's version as text (Postgres returns bigint as a string); `'0'` when the row is absent. */
export async function readVersion(driver: OrmDriver, domain: string): Promise<string> {
  const rows = (await driver.select().from(AUTHZ_VERSION_TABLE).where('domain', domain)) as { version: unknown }[];
  return rows.length === 0 ? '0' : String(rows[0].version);
}
