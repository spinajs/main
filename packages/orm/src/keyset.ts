import { createHash } from 'node:crypto';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import { SortOrder } from './enums.js';
import { InvalidCursor } from './exceptions.js';
import type { IModelDescriptor, ISort, IWhereBuilder, KeysetPage } from './interfaces.js';
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

export function decodeCursor(columns: KeysetColumn[], cursor: string): unknown[] {
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

  return v.map(decodeValue);
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
  const hasNext = request.backward || more;
  const hasPrevious = request.backward ? more : request.cursor !== undefined;

  return {
    items,
    next: last !== undefined && hasNext ? encodeCursor(columns, last) : null,
    previous: first !== undefined && hasPrevious ? encodeCursor(columns, first) : null,
  };
}
