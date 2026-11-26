import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { HISTORY_COVERAGE_TABLE, HISTORY_COVERAGE_WIDTHS } from './coverage-table.js';

/** `history_coverage` on the default connection. Every other connection that holds a tracked model: a subclass with its own `@Migration`. */
@Migration('default')
export class OrmHistoryCoverage_2026_11_25_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    const W = HISTORY_COVERAGE_WIDTHS;
    await connection.schema().createTable(HISTORY_COVERAGE_TABLE, (table) => {
      table.bigint('id').primaryKey().autoIncrement();
      table.string('trail', W.trail).notNull().exact();
      table.string('connection', W.connection).notNull().exact();
      table.string('entity', W.entity).notNull().exact();
      table.dateTime('since').notNull();
      table.longtext('columns').notNull().exact();
    });
    // The key of a row. An index, because the MSSQL table compiler cannot write a primary key of three columns.
    await connection.index().table(HISTORY_COVERAGE_TABLE).name(`${HISTORY_COVERAGE_TABLE}_key`).columns(['trail', 'connection', 'entity']).unique();
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(HISTORY_COVERAGE_TABLE).ifExists();
  }
}
