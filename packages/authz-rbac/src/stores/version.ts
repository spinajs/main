import type { AuthzTx } from '@spinajs/authz';
import { ormReady } from '@spinajs/orm';
import type { IUpdateResult, OrmDriver } from '@spinajs/orm';

import { requireTransaction } from './context.js';
import { VersionRecord } from './records.js';
import { AUTHZ_VERSION_TABLE } from './tables.js';

/** `authz_version(domain) += 1` in the transaction of `tx`, creating the row at 1. */
export async function bumpVersion(tx: AuthzTx, domain: string, where = 'bumpVersion'): Promise<void> {
  const driver = requireTransaction(VersionRecord, tx, where);
  if ((await increment(driver, domain)) > 0) return;
  await driver.insert().into(AUTHZ_VERSION_TABLE).values({ domain, version: 0 }).orIgnore();
  await increment(driver, domain);
}

async function increment(driver: OrmDriver, domain: string): Promise<number> {
  const result: IUpdateResult = await driver.update().in(AUTHZ_VERSION_TABLE).increment('version').where('domain', domain);
  return result.RowsAffected;
}

/** The domain's version; `'0'` when the row is absent. */
export async function readVersion(domain: string): Promise<string> {
  await ormReady();
  const [row] = await VersionRecord.where('domain', domain);
  return row?.version ?? '0';
}
