import { QueryContext } from '@spinajs/orm';
import { RunLogModel } from '../models/RunLogModel.js';
import { defaultSqlDriver, quoteFor, RawSqlDriver, sqlDialect } from '../store/raw-sql.js';

export type JournalRow = Pick<RunLogModel, 'RunId' | 'Schedule' | 'Seq' | 'Attempt' | 'Ts' | 'Kind' | 'Data'> &
  Partial<Pick<RunLogModel, 'Level' | 'Step' | 'Message'>>;

export interface JournalPositionSql {
  bump: string;
  unbump: string;
  read: string;
  serializeInProcess: boolean;
}

export function journalPositionSql(driverName: string): JournalPositionSql {
  const dialect = sqlDialect(driverName, 'journal position statements');
  const q = quoteFor(dialect);
  const table = q('__scheduler_journal_pos');
  return {
    bump: `UPDATE ${table} SET ${q('LastPos')} = ${q('LastPos')} + 1 WHERE ${q('Id')} = 1`,
    unbump: `UPDATE ${table} SET ${q('LastPos')} = ${q('LastPos')} - 1 WHERE ${q('Id')} = 1`,
    read: `SELECT ${q('LastPos')} AS pos FROM ${table} WHERE ${q('Id')} = 1`,
    serializeInProcess: dialect === 'sqlite',
  };
}

const chains = new WeakMap<object, Promise<unknown>>();

async function readPosition(driver: RawSqlDriver, sql: string): Promise<number> {
  const rows = (await driver.executeOnDb(sql, [], QueryContext.Select)) as Array<{ pos: number | string }>;
  return Number(rows[0].pos);
}

/**
 * Inserts one journal row at the next global position. On Postgres/MySQL the counter row
 * stays locked until commit, so positions become visible in commit order on every replica.
 * SQLite has one shared handle per process, where a transaction would also capture statements of
 * other async paths, so appends are serialized in memory instead (SQLite is not a multi-replica target).
 */
export async function appendJournalRow(row: JournalRow): Promise<RunLogModel> {
  const driver = await defaultSqlDriver();
  const sql = journalPositionSql(driver.Options.Driver);

  if (!sql.serializeInProcess) {
    // The ORM runs every statement issued inside the callback on the transaction's own connection.
    return driver.transaction(async () => {
      await driver.executeOnDb(sql.bump, [], QueryContext.Update);
      return RunLogModel.create({ ...row, Pos: await readPosition(driver, sql.read) });
    });
  }

  const append = async () => {
    await driver.executeOnDb(sql.bump, [], QueryContext.Update);
    const pos = await readPosition(driver, sql.read);
    try {
      return await RunLogModel.create({ ...row, Pos: pos });
    } catch (err) {
      await driver.executeOnDb(sql.unbump, [], QueryContext.Update);
      throw err;
    }
  };
  const next = (chains.get(driver) ?? Promise.resolve()).catch(() => undefined).then(append);
  chains.set(driver, next);
  return next;
}
