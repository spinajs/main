import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SortOrder } from './enums.js';
import type { IModelDescriptor, ISort, IWhereBuilder } from './interfaces.js';
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
