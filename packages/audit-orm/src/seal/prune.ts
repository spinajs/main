import type { OrmDriver } from '@spinajs/orm';

import { SEAL_PAGE_SIZE, sealsAfter } from './seals.js';
import { AUDIT_SEAL_TABLE } from './table.js';

// Inside a transaction the caller holds open, the work commits with it: a savepoint of ours there could interleave with the caller's.
const ownTransaction = <R>(driver: OrmDriver, work: () => Promise<R>): Promise<R> => (driver.CurrentTransaction !== undefined ? work() : driver.transaction(work));

/**
 * Retention on a sealed table: removes the events of every seal sealed before `before`, in chain order, and marks
 * those seals pruned. A range goes as a whole or not at all, and events not sealed yet stay.
 */
export async function pruneSealed(driver: OrmDriver, table: string, before: Date, now: Date = new Date()): Promise<number> {
  let deleted = 0;
  // spinajs-orm-ignore ORM102: deliberate batching, one DELETE and one UPDATE per seal
  for (;;) {
    const seals = await sealsAfter(driver, table, 0, { unprunedOnly: true });
    for (const seal of seals) {
      // The chain is in time order: the first seal that is not older than the cutoff ends the run.
      if (!(seal.sealedAt.getTime() < before.getTime())) return deleted;
      deleted += await ownTransaction(driver, async () => {
        const removed = await driver.del().from(table).where('seq', '>=', seal.fromSeq).where('seq', '<=', seal.toSeq);
        await driver.update().in(AUDIT_SEAL_TABLE).update({ pruned_at: now }).where('id', seal.id);
        return removed.RowsAffected;
      });
    }
    if (seals.length < SEAL_PAGE_SIZE) return deleted;
  }
}
