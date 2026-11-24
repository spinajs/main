import { extractModelDescriptor, pkColumns, pkGeneration } from '@spinajs/orm';
import type { DbServerResponse, IColumnDescriptor, InsertQueryBuilder } from '@spinajs/orm';

/** The lone `auto` primary key column that table info flags as the rowid alias. */
function rowidColumn(insert: InsertQueryBuilder): IColumnDescriptor | undefined {
  const descriptor = insert.Model === undefined ? null : extractModelDescriptor(insert.Model);
  const pk = descriptor ? pkColumns(descriptor) : [];
  if (!descriptor || pk.length !== 1 || pkGeneration(descriptor, pk[0]) !== 'auto') return undefined;
  const column = descriptor.Columns.find((c) => c.Name === pk[0]);
  return column?.AutoIncrement === true ? column : undefined;
}

/**
 * Table info cannot tell a WITHOUT ROWID table, where an INTEGER PRIMARY KEY is no rowid alias and `lastID` keeps an
 * earlier statement's rowid. Its key is NOT NULL, so its row either supplies the key or takes the column default.
 */
function lastIdNamesTheRow(lastId: number, supplied: unknown, column: IColumnDescriptor): boolean {
  if (supplied === null || supplied === undefined) return column.DefaultValue === null || column.DefaultValue === undefined;
  return supplied === lastId;
}

/**
 * SQLite's key of an insert that came back without RETURNING rows: `lastID` for one row the statement wrote into a
 * rowid table through its INTEGER PRIMARY KEY. Several rows have no known keys: `lastID` names the last of them.
 */
export function rowidKeys(mapped: DbServerResponse, insert: InsertQueryBuilder): Array<Record<string, unknown>> | undefined {
  const column = rowidColumn(insert);
  const lastId = mapped.LastInsertId;
  // An ON CONFLICT DO UPDATE that updated counts one change and leaves lastID at an earlier insert's rowid.
  if (column === undefined || insert.Values.length !== 1 || insert.Update) return undefined;
  // A statement that inserted nothing (a skipped OR IGNORE row, a RAISE(IGNORE) trigger) leaves lastID as it was.
  if (mapped.RowsAffected !== 1 || !Number.isSafeInteger(lastId) || lastId <= 0) return undefined;
  return lastIdNamesTheRow(lastId, insert.getColumnValues(column.Name)[0], column) ? [{ [column.Name]: lastId }] : undefined;
}
