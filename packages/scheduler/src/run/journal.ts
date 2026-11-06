import { defaultSqlDriver } from '@spinajs/durable';
import type { OrmDriver } from '@spinajs/orm';
import { RunLogModel } from '../models/RunLogModel.js';

export type JournalRow = Pick<RunLogModel, 'RunId' | 'Schedule' | 'Seq' | 'Attempt' | 'Ts' | 'Kind' | 'Data'> &
  Partial<Pick<RunLogModel, 'Level' | 'Step' | 'Message'>>;

const chains = new WeakMap<object, Promise<unknown>>();

const POSITION_TABLE = '__scheduler_journal_pos';

async function bump(driver: OrmDriver, by: 1 | -1): Promise<void> {
  await driver.update().in(POSITION_TABLE).increment('LastPos', by).where('Id', 1);
}

// `onPrimary` is not exported by durable at w-01; the read runs inside the bump's transaction, or on a driver without replicas
async function readPosition(driver: OrmDriver): Promise<number> {
  const rows = (await driver.select().from(POSITION_TABLE).columns(['LastPos']).where('Id', 1)) as Array<{ LastPos: number | string }>;
  return Number(rows[0].LastPos);
}

/**
 * Inserts one journal row at the next global position. On drivers with concurrent transactions the
 * counter row stays locked until commit, so positions become visible in commit order on every replica.
 * Drivers without them (sqlite, PGlite) have one shared handle per process, where a transaction would also
 * capture statements of other async paths, so appends are serialized in memory instead.
 */
export async function appendJournalRow(row: JournalRow): Promise<RunLogModel> {
  const driver = await defaultSqlDriver('scheduler');

  if (driver.supportedFeatures().concurrentTransactions !== false) {
    // The ORM runs every statement issued inside the callback on the transaction's own connection.
    return driver.transaction(async () => {
      await bump(driver, 1);
      return RunLogModel.create({ ...row, Pos: await readPosition(driver) });
    });
  }

  const append = async () => {
    await bump(driver, 1);
    const pos = await readPosition(driver);
    try {
      return await RunLogModel.create({ ...row, Pos: pos });
    } catch (err) {
      await bump(driver, -1);
      throw err;
    }
  };
  const next = (chains.get(driver) ?? Promise.resolve()).catch(() => undefined).then(append);
  chains.set(driver, next);
  return next;
}
