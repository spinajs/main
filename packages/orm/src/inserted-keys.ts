import type { InsertQueryBuilder } from './builders/insert.js';
import { extractModelDescriptor } from './descriptor.js';
import type { DbServerResponse, IModelDescriptor } from './interfaces.js';
import { pkColumns } from './primary-keys.js';

type InsertedKey = Record<string, unknown>;

/** The model descriptor of an insert whose model has a primary key. */
export function insertDescriptor(insert: InsertQueryBuilder): IModelDescriptor | undefined {
  const descriptor = insert.Model === undefined ? null : extractModelDescriptor(insert.Model);
  return descriptor && pkColumns(descriptor).length > 0 ? descriptor : undefined;
}

const isRow = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

function keyOf(row: unknown, pk: readonly string[]): InsertedKey | undefined {
  if (!isRow(row)) return undefined;
  const values = pk.map((c): [string, unknown] => [c, Reflect.get(row, c)]);
  return values.every(([, v]) => v !== null && v !== undefined) ? Object.fromEntries(values) : undefined;
}

/** The RETURNING rows projected to the key, when there is one with a whole key for every inserted row. */
export function returningRowKeys(response: DbServerResponse, rows: number, pk: readonly string[]): InsertedKey[] | undefined {
  const returning: unknown[] = Array.isArray(response.Returning) ? response.Returning : [];
  if (returning.length !== rows) return undefined;
  const keys = returning.map((row) => keyOf(row, pk));
  return keys.every((k): k is InsertedKey => k !== undefined) ? keys : undefined;
}
