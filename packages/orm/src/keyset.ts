import { createHash } from 'node:crypto';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import type { ColumnFamily, SqlDialectProfile } from '@spinajs/manifest';
import { DateTime } from 'luxon';
import { SortOrder } from './enums.js';
import { InvalidCursor } from './exceptions.js';
import type { IModelDescriptor, ISort, IWhereBuilder, KeysetPage } from './interfaces.js';
import { familiesOf } from './schema-diff/families.js';
import { pkColumns } from './primary-keys.js';
import type { WhereFunction } from './types.js';

export type KeysetDirection = 'asc' | 'desc';

export interface KeysetColumn {
  column: string;
  order: KeysetDirection;
}

interface KeysetPair extends KeysetColumn {
  value: unknown;
}

/** `order` followed by every primary key column it lacks, ascending: the tie-breaker that makes each position unique. */
export function keysetColumns(order: ReadonlyArray<readonly [string, KeysetDirection]>, descriptor: IModelDescriptor | undefined): KeysetColumn[] {
  const keys = descriptor ? pkColumns(descriptor) : [];
  if (keys.length === 0) {
    throw new InvalidOperation(`keyset paging needs a primary key to break ties; model ${descriptor?.Name ?? '(none)'} has none`);
  }

  const columns: KeysetColumn[] = order.map(([column, direction]) => ({ column, order: direction }));
  for (const key of keys) {
    if (!columns.some((c) => c.column === key)) {
      columns.push({ column: key, order: 'asc' });
    }
  }

  return columns;
}

export function keysetOfSorts(sorts: ISort[]): Array<[string, KeysetDirection]> {
  return sorts.map((s) => [s.column, s.order === SortOrder.DESC ? 'desc' : 'asc']);
}

/**
 * Refuses a nullable order column before any page is fetched. NULLs sort first ascending on sqlite and mysql and last on
 * postgres, so a walk would reach them on the last pages and fail there. Key columns are exempt: sqlite reports an
 * `INTEGER PRIMARY KEY` as nullable, and a key is never NULL.
 */
export function assertKeysetNotNull(columns: KeysetColumn[], descriptor: IModelDescriptor): void {
  for (const { column } of columns) {
    const described = descriptor.Columns?.find((c) => c.Name === column);
    if (described && described.Nullable && !described.PrimaryKey) {
      throw new InvalidArgument(`keyset paging needs NOT NULL order columns: ${descriptor.Name}.${column} is nullable`, 'orderBy');
    }
  }
}

/** The row's values of the keyset columns. A NULL cannot be compared past, so it is refused. */
export function keysetValues(columns: KeysetColumn[], row: unknown): unknown[] {
  return columns.map(({ column }) => {
    const value: unknown = Reflect.get(row as object, column);
    if (value === null || value === undefined) {
      throw new InvalidOperation(`keyset paging needs NOT NULL order columns: ${column} is ${String(value)} in the row`);
    }
    return value;
  });
}

function keysetBranch(pairs: KeysetPair[], index: number, side: 'after' | 'before'): WhereFunction<unknown> {
  const current = pairs.slice(index, index + 1)[0];
  const equal = pairs.slice(0, index);
  const operator = (current.order === 'asc') === (side === 'after') ? '>' : '<';

  return function () {
    for (const pair of equal) {
      this.where(pair.column, '=', pair.value);
    }
    this.where(current.column, operator, current.value);
  };
}

/**
 * Narrows `query` to the rows past (`after`) or before (`before`) `values` in `columns` order:
 * `(a > ?) OR (a = ? AND b > ?) OR …`, each comparison flipped for a descending column.
 */
export function applyKeysetPredicate(query: IWhereBuilder<unknown>, columns: KeysetColumn[], values: unknown[], side: 'after' | 'before'): void {
  const pairs: KeysetPair[] = columns.map((c, i) => ({ ...c, value: values.at(i) }));
  const branches = pairs.map((_, i) => keysetBranch(pairs, i, side));

  query.where(function () {
    for (const [i, branch] of branches.entries()) {
      if (i === 0) {
        this.where(branch);
      } else {
        this.orWhere(branch);
      }
    }
  });
}

interface CursorPayload {
  h: string;
  v: unknown[];
}

const MAX_CURSOR_LENGTH = 4096;
const INT32 = 2 ** 31;
const INT64 = 2n ** 63n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?\d+(\.\d+)?$/;

const inInt64 = (value: bigint): boolean => value >= -INT64 && value < INT64;
const isString = (value: unknown): boolean => typeof value === 'string';
const isDateTime = (value: unknown): boolean => DateTime.isDateTime(value);

/**
 * The decoded values a column of each family may be compared with, so a crafted cursor is refused here instead of
 * failing as a SQL data error. `integer` is 32-bit unless the native type also holds `bigint` (sqlite's INTEGER);
 * `bigint` also takes a number and a digit string, which is how sqlite and pg hand int8 back; `boolean` also takes 0
 * and 1, which sqlite returns without a converter. A type none of whose families is listed (json, binary) is unchecked.
 */
const FAMILY_VALUES: Partial<Record<ColumnFamily, (value: unknown, families: readonly ColumnFamily[]) => boolean>> = {
  integer: (value, families) => Number.isSafeInteger(value) && (families.includes('bigint') || ((value as number) >= -INT32 && (value as number) < INT32)),
  bigint: (value) => Number.isSafeInteger(value) || (typeof value === 'bigint' && inInt64(value)) || (typeof value === 'string' && /^-?\d+$/.test(value) && inInt64(BigInt(value))),
  decimal: (value) => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && DECIMAL.test(value)),
  float: (value) => typeof value === 'number' && Number.isFinite(value),
  text: isString,
  enum: isString,
  time: (value) => typeof value === 'string' && /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value),
  boolean: (value) => typeof value === 'boolean' || value === 0 || value === 1,
  date: isDateTime,
  datetime: isDateTime,
  uuid: (value) => typeof value === 'string' && UUID.test(value),
};

/** The families of each keyset column from the driver's dialect profile; undefined where the type is unknown. */
export function keysetFamilies(columns: KeysetColumn[], descriptor: IModelDescriptor | undefined, dialect: SqlDialectProfile | undefined): Array<ColumnFamily[] | undefined> {
  return columns.map(({ column }) => {
    const described = descriptor?.Columns?.find((c) => c.Name === column);
    const native = described?.NativeType || described?.Type;
    return native ? familiesOf(native, dialect) : undefined;
  });
}

function fitsFamilies(value: unknown, families: readonly ColumnFamily[] | undefined): boolean {
  if (!families || families.every((f) => FAMILY_VALUES[f] === undefined)) {
    return true;
  }
  return families.some((f) => FAMILY_VALUES[f]?.(value, families) === true);
}

/** Names the order a cursor was made for, so a cursor from another listing is refused instead of misread. */
export function keysetHash(columns: KeysetColumn[]): string {
  return createHash('sha256')
    .update(JSON.stringify(columns.map((c) => [c.column, c.order])))
    .digest('base64url')
    .slice(0, 16);
}

function encodeValue(column: string, value: unknown): unknown {
  if (DateTime.isDateTime(value)) {
    const iso = value.toUTC().toISO();
    if (iso === null) {
      throw new InvalidOperation(`keyset paging cannot put ${column} in a cursor: the datetime is invalid`);
    }
    return { $d: iso };
  }

  if (value instanceof Date) {
    return { $d: value.toISOString() };
  }

  if (typeof value === 'bigint') {
    return { $b: value.toString() };
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  throw new InvalidOperation(`keyset paging cannot put ${column} in a cursor: it holds a ${typeof value}`);
}

function decodeValue(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  const tagged = (typeof value === 'object' && value !== null ? value : {}) as { $d?: unknown; $b?: unknown };
  if (typeof tagged.$d === 'string') {
    const at = DateTime.fromISO(tagged.$d, { zone: 'utc' });
    if (at.isValid) {
      return at;
    }
  }

  if (typeof tagged.$b === 'string' && /^-?\d+$/.test(tagged.$b)) {
    return BigInt(tagged.$b);
  }

  throw new InvalidCursor('cursor holds a value of an unknown shape');
}

export function encodeCursor(columns: KeysetColumn[], row: unknown): string {
  const values = keysetValues(columns, row);
  const payload: CursorPayload = { h: keysetHash(columns), v: columns.map((c, i) => encodeValue(c.column, values.at(i))) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(columns: KeysetColumn[], cursor: string, families: ReadonlyArray<readonly ColumnFamily[] | undefined> = []): unknown[] {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidCursor('cursor is too long');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursor('cursor is not a page cursor');
  }

  const { h, v } = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<CursorPayload>;
  if (typeof h !== 'string' || !Array.isArray(v) || v.length !== columns.length) {
    throw new InvalidCursor('cursor is not a page cursor');
  }

  if (h !== keysetHash(columns)) {
    throw new InvalidCursor('cursor was made for another order');
  }

  const values = v.map(decodeValue);
  for (const [i, { column }] of columns.entries()) {
    if (!fitsFamilies(values.at(i), families.at(i))) {
      throw new InvalidCursor(`cursor value for ${column} does not fit the column`);
    }
  }

  return values;
}

/** One page out of `limit + 1` fetched rows: drops the probe row, restores a backward page's order, makes its cursors. */
export function keysetPage<R>(columns: KeysetColumn[], rows: R[], limit: number, request: { cursor: string | undefined; backward: boolean }): KeysetPage<R> {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  if (request.backward) {
    items.reverse();
  }

  const first = items.at(0);
  const last = items.at(-1);
  // an empty page before the first row still leads back to where it was asked from
  if (request.backward && last === undefined) {
    return { items, next: request.cursor ?? null, previous: null };
  }

  const hasNext = request.backward || more;
  const hasPrevious = request.backward ? more : request.cursor !== undefined;

  return {
    items,
    next: last !== undefined && hasNext ? encodeCursor(columns, last) : null,
    previous: first !== undefined && hasPrevious ? encodeCursor(columns, first) : null,
  };
}
