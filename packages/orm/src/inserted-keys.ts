import type { InsertQueryBuilder } from './builders/insert.js';
import { extractModelDescriptor } from './descriptor.js';
import type { DbServerResponse, IModelDescriptor } from './interfaces.js';
import { pkColumns, pkGeneration } from './primary-keys.js';

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

function identityColumn(descriptor: IModelDescriptor): string | undefined {
  const pk = pkColumns(descriptor);
  if (pk.length !== 1 || pkGeneration(descriptor, pk[0]) !== 'auto') return undefined;
  return descriptor.Columns.find((c) => c.Name === pk[0])?.AutoIncrement === true ? pk[0] : undefined;
}

// A dialect whose reported id is the first of a contiguous block: one plain statement that inserted every row it sent.
function isContiguousBatch(response: DbServerResponse, insert: InsertQueryBuilder, pk: string): boolean {
  if (insert.Driver.supportedFeatures().insertIdIsFirstOfBatch !== true) return false;
  if (insert.Ignore || insert.Replace || insert.Update) return false;
  if (response.RowsAffected !== insert.Values.length) return false;
  return insert.getColumnValues(pk).every((v) => v === null || v === undefined) && insert.splitByDriverLimits().length === 1;
}

/** The pre-driver rule for keys read off `LastInsertId`, kept until every connection package reports its own keys. */
export function legacyIdentityKeys(response: DbServerResponse, insert: InsertQueryBuilder, descriptor: IModelDescriptor): InsertedKey[] | undefined {
  const pk = identityColumn(descriptor);
  const first = response.LastInsertId;
  if (pk === undefined || !Number.isSafeInteger(first) || first <= 0) return undefined;
  const rows = insert.Values.length;
  if (rows !== 1 && !isContiguousBatch(response, insert, pk)) return undefined;
  return Array.from({ length: rows }, (_, k) => Object.fromEntries([[pk, first + k]]));
}
