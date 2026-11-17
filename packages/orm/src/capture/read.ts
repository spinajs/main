import type { Constructor } from '@spinajs/di';

import { lookupValue } from '../column-kind.js';
import { extractModelDescriptor } from '../descriptor.js';
import type { OrmDriver } from '../driver.js';
import { findColumn } from '../helpers.js';
import type { ModelBase } from '../model.js';
import type { CapturedRow } from './contracts.js';
import { captureKeyText } from './keys.js';

const IN_CHUNK = 500;

/**
 * The rows whose `by` column (the primary key unless named) holds one of `keys`, keyed by primary key text; read raw,
 * so converters and select middlewares never touch them.
 */
export async function readRows(driver: OrmDriver, model: Constructor<ModelBase>, table: string, pk: string, columns: readonly string[] | '*', keys: readonly string[], by = pk): Promise<Map<string, CapturedRow>> {
  const out = new Map<string, CapturedRow>();
  const column = findColumn(extractModelDescriptor(model)?.Columns, by);
  // A key no row can have is left out rather than bound: binding it fails the cast on some databases and matches a coerced key on others.
  const values = keys.map((k) => (column ? lookupValue(column, k) : k)).filter((v) => v !== undefined);
  // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK keys
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    // A builder without a model: table, key and columns are run-time names, and it always runs on the primary.
    const select = driver.select<CapturedRow[]>().from(table);
    if (columns !== '*') select.columns([...new Set([pk, ...columns])]);
    const rows = await select.whereIn(by, values.slice(i, i + IN_CHUNK));
    for (const row of rows) {
      const key = captureKeyText(row[pk]);
      if (key !== undefined) out.set(key, row);
    }
  }
  return out;
}
