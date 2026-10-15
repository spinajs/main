import type { OrmDriver } from '@spinajs/orm';

import { ormLog } from '../host.js';

/** L1's driver.afterCommit; the data is committed when `fn` runs, so its failure is logged, not thrown. */
export async function afterCommit(driver: OrmDriver, what: string, fn: () => Promise<void>): Promise<void> {
  await driver.afterCommit(async () => {
    try {
      await fn();
    } catch (e) {
      ormLog().error(`authz-orm: ${what} after a committed delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
