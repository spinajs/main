import type { AuthzTx } from '@spinajs/authz';
import type { IUpdateResult, OrmDriver } from '@spinajs/orm';

import { requireTransaction } from './context.js';
import { VersionRecord } from './records.js';
import { AUTHZ_VERSION_TABLE } from './tables.js';

/** `authz_version(domain) += 1` in the transaction of `tx`, creating the row at 1; the new version. */
export async function bumpVersion(tx: AuthzTx, domain: string, where = 'bumpVersion'): Promise<number> {
  const driver = requireTransaction(VersionRecord, tx, where);
  if ((await increment(driver, domain)) === 0) {
    await driver.insert().into(AUTHZ_VERSION_TABLE).values({ domain, version: 0 }).orIgnore();
    await increment(driver, domain);
  }
  // Read in the transaction: outside it the bump is not committed yet.
  const [row] = (await driver.select().from(AUTHZ_VERSION_TABLE).where('domain', domain)) as { version: number | string }[];
  return Number(row.version);
}

async function increment(driver: OrmDriver, domain: string): Promise<number> {
  const result: IUpdateResult = await driver.update().in(AUTHZ_VERSION_TABLE).increment('version').where('domain', domain);
  return result.RowsAffected;
}

/** The domain's version; `'0'` when the row is absent. */
export async function readVersion(domain: string): Promise<string> {
  const [row] = await VersionRecord.where('domain', domain);
  return row?.version ?? '0';
}
