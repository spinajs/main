import type { Constructor } from '@spinajs/di';

import { lookupValue } from '../column-kind.js';
import { extractModelDescriptor } from '../descriptor.js';
import type { OrmDriver } from '../driver.js';
import { findColumn } from '../helpers.js';
import type { ModelBase } from '../model.js';
import type { CapturedRow } from './contracts.js';
import { captureKeyText, columnValue } from './keys.js';

const IN_CHUNK = 500;

/** Rows keyed by primary key text, and for each read the primary key values with no text it met. */
export interface Reads {
  readonly rows: Map<string, CapturedRow>;
  readonly keyless: readonly (readonly unknown[])[];
}

export const noReads = (): Reads => ({ rows: new Map<string, CapturedRow>(), keyless: [] });

/** The keyless key values a key select or an insert's keys met, without rows. */
export const keylessRead = (values: readonly unknown[]): Reads => ({ rows: new Map<string, CapturedRow>(), keyless: [values] });

/** A row several reads returned holds the values of the last of them. */
export const mergeReads = (reads: readonly Reads[]): Reads => ({ rows: new Map(reads.flatMap((r) => [...r.rows])), keyless: reads.flatMap((r) => r.keyless) });

/**
 * The rows whose `by` column (the primary key unless named) holds one of `keys`, keyed by primary key text; read raw,
 * so converters and select middlewares never touch them. With `lock`, a locking read: under MySQL REPEATABLE READ a
 * plain select would return the transaction's snapshot, not the row the statement overwrites. `database` is the one
 * the write names.
 */
export async function readRows(driver: OrmDriver, model: Constructor<ModelBase>, table: string, pk: string, columns: readonly string[] | '*', keys: readonly string[], by = pk, lock = false, database?: string): Promise<Reads> {
  const out = new Map<string, CapturedRow>();
  const keyless: unknown[] = [];
  const column = findColumn(extractModelDescriptor(model)?.Columns, by);
  // A key no row can have is left out rather than bound: binding it fails the cast on some databases and matches a coerced key on others.
  const values = keys.map((k) => (column ? lookupValue(column, k) : k)).filter((v) => v !== undefined);
  // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK keys
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    // A builder without a model: table, key and columns are run-time names, and it always runs on the primary.
    const select = driver.select<CapturedRow[]>().from(table);
    if (database) select.database(database);
    if (columns !== '*') select.columns([...new Set([pk, ...columns])]);
    if (lock) select.forUpdate();
    const rows = await select.whereIn(by, values.slice(i, i + IN_CHUNK));
    for (const row of rows) {
      const value = columnValue(row, pk);
      const key = captureKeyText(value);
      if (key === undefined) keyless.push(value);
      else out.set(key, row);
    }
  }
  return { rows: out, keyless: [keyless] };
}
