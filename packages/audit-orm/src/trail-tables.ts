// A table of the trail's name that lacks these is not a trail table: retention and erasure leave it alone.
const TRAIL_COLUMNS = ['seq', 'at', 'data_hash'];

function columnNames(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  const list: readonly unknown[] = columns;
  const names: string[] = [];
  for (const column of list) {
    const name: unknown = column !== null && typeof column === 'object' ? Reflect.get(column, 'Name') : undefined;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

/**
 * `trail` when `table` on `driver` has the trail columns, `other` when a table of that name lacks them, `none` when there
 * is none. Only `tableInfo` is used, typed loosely: the MSSQL driver answers null for a missing table.
 */
export async function trailTableOn(driver: { tableInfo(table: string): Promise<unknown> }, table: string): Promise<'trail' | 'other' | 'none'> {
  const names = columnNames(await driver.tableInfo(table));
  if (TRAIL_COLUMNS.every((c) => names.includes(c))) return 'trail';
  return names.length > 0 ? 'other' : 'none';
}
