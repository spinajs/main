import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import type { TableQueryBuilder } from '@spinajs/orm';

type Row = Record<string, unknown>;

const SCHEDULES = '__scheduler';
const RUNS = '__scheduler_run';
const KEYED = '__scheduler_keyed';
const GLOBAL_ONLY = '__scheduler_global';

/** The columns of `__scheduler` as `Scheduler_2026_10_15_00_00_00` created them. */
function scheduleColumns(t: TableQueryBuilder): void {
  t.string('Name', 128).primaryKey().notNull();
  t.longtext('Definition').notNull();
  t.string('DefinitionHash', 64).notNull();
  t.bigint('NextRunAt');
  t.bigint('LastFiredAt');
  t.bigint('LastFinishedAt');
  t.string('LastStatus', 16);
  t.string('LastRunId', 36);
  t.boolean('Paused').notNull();
  t.string('PausedReason', 16);
  t.boolean('HardPaused').notNull();
  t.int('ConsecutiveFailures').notNull();
  t.bigint('LastSuccessAt');
  t.string('LeaseOwner', 128);
  t.bigint('LeaseUntil');
  t.boolean('Orphaned').notNull();
  t.bigint('UpdatedAt').notNull();
}

async function hasColumn(connection: OrmDriver, table: string, column: string): Promise<boolean> {
  if (!(await connection.schema().tableExists(table))) return false;
  return (await connection.tableInfo(table)).some((c) => c.Name === column);
}

/**
 * Replaces `__scheduler` by `rebuilt`, filled with the rows `map` keeps. The schema builder cannot drop a
 * primary key, hence the copy; the table holds one row per schedule. MySQL commits every DDL statement, so a
 * second run continues an interrupted one: while `__scheduler` exists it holds every row, after that `rebuilt` does.
 */
async function rebuildSchedules(
  connection: OrmDriver,
  rebuilt: string,
  columns: (t: TableQueryBuilder) => void,
  map: (row: Row) => Row | undefined,
): Promise<void> {
  if (await connection.schema().tableExists(SCHEDULES)) {
    await connection.schema().dropTable(rebuilt).ifExists();
    await connection.schema().createTable(rebuilt, columns);
    for (const row of await connection.select<Row[]>().from(SCHEDULES)) {
      const copy = map(row);
      if (copy) await connection.insert().into(rebuilt).values(copy);
    }
    await connection.schema().dropTable(SCHEDULES);
  }
  // created after the drop: PostgreSQL and SQLite name indexes per schema, not per table
  await connection.index().table(rebuilt).name('__scheduler_due').columns(['Paused', 'NextRunAt']);
  await connection.schema().alterTable(rebuilt, (t) => t.rename(SCHEDULES));
}

/**
 * One `__scheduler` row per instance of a schedule: the key becomes (`Name`, `Tenant`), `''` for the global
 * instance. `Tenant` is NOT NULL so that the key never holds a NULL, which unique indexes treat differently
 * per dialect. `__scheduler_run.Tenant` is NULL for a run of the global instance.
 */
@Migration('default')
export class Scheduler_2026_11_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!(await hasColumn(connection, SCHEDULES, 'Tenant'))) {
      await rebuildSchedules(
        connection,
        KEYED,
        (t) => {
          scheduleColumns(t);
          t.string('Tenant', 64).primaryKey().notNull().default().value('');
        },
        (row) => ({ ...row, Tenant: '' }),
      );
    }

    if (!(await hasColumn(connection, RUNS, 'Tenant'))) {
      await connection.schema().alterTable(RUNS, (t) => {
        t.string('Tenant', 64);
      });
      await connection.index().table(RUNS).name('__scheduler_run_instance').columns(['Schedule', 'Tenant', 'Status']);
    }
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (await hasColumn(connection, RUNS, 'Tenant')) {
      await connection.index().table(RUNS).name('__scheduler_run_instance').drop();
      await connection.schema().alterTable(RUNS, (t) => t.dropColumn('Tenant'));
    }

    const interrupted = !(await connection.schema().tableExists(SCHEDULES));
    if (interrupted || (await hasColumn(connection, SCHEDULES, 'Tenant'))) {
      await rebuildSchedules(connection, GLOBAL_ONLY, scheduleColumns, ({ Tenant, ...row }) =>
        Tenant === '' ? row : undefined,
      );
    }
  }
}
