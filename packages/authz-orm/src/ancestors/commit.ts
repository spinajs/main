import { thrownError } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { ormLog } from '../host.js';

/** L1's driver.afterCommit; the data is committed when `fn` runs, so its failure is logged, not thrown. */
export async function afterCommit(driver: OrmDriver, step: string, fn: () => Promise<void>): Promise<void> {
  await driver.afterCommit(async () => {
    try {
      await fn();
    } catch (e) {
      ormLog().error({ error: thrownError(e), step }, 'authz-orm: ${step} after a committed delete failed');
    }
  });
}
