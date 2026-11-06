import type { SqlDialectProfile } from '@spinajs/manifest';
import type { OrmDriver } from '../driver.js';
import type { IColumnDescriptor } from '../interfaces.js';
import { sqlDialectOf } from '../sql-dialect.js';
import type { LiveExtras } from './types.js';

export interface LiveSchema {
  columns: Map<string, IColumnDescriptor[]>;
  extras: LiveExtras;
  dialect: SqlDialectProfile | undefined;
}

/** What `driver` reports for `tables`; a table it does not find is left out of `columns`. */
export async function introspectSchema(driver: OrmDriver, tables: readonly string[]): Promise<LiveSchema> {
  const columns = new Map<string, IColumnDescriptor[]>();
  const extras: LiveExtras = new Map();
  const schema = driver.Options.Database;
  for (const name of tables) {
    // drivers answer null for a missing table, whatever the signature says
    const found = (await driver.tableInfo(name, schema)) as IColumnDescriptor[] | null;
    if (!found) continue;
    columns.set(name, found);
    const rows = await driver.select<unknown[]>().from(name).take(1);
    extras.set(name, {
      indexes: driver.tableIndexes ? await driver.tableIndexes(name, schema) : undefined,
      foreignKeys: driver.tableForeignKeys ? await driver.tableForeignKeys(name, schema) : undefined,
      hasRows: rows.length > 0,
    });
  }
  return { columns, extras, dialect: sqlDialectOf(driver.constructor as abstract new (...args: never[]) => unknown) };
}
