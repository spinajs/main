import { SortOrder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';

export interface Page {
  limit: number;
  offset: number;
}

export interface Sort {
  column: string;
  order: SortOrder;
}

/** Page used when a request sends none. */
export const DEFAULT_PAGE: Readonly<Page> = Object.freeze({ limit: 50, offset: 0 });

/** Ceiling `readPage` clamps `limit` to unless `maxLimit` says otherwise. */
export const MAX_PAGE_LIMIT = 500;

/** Throws for a malformed value; must not return. Map it to your own error (a 400, an admin failure code). */
export type InvalidInput = (field: string, message: string) => never;

export interface PageOptions {
  /** Limit when the input has none. Default {@link DEFAULT_PAGE}.limit. */
  defaultLimit?: number;

  /** A larger `limit` is clamped, not rejected. Default {@link MAX_PAGE_LIMIT}. */
  maxLimit?: number;

  /** Default throws `InvalidArgument` with the field name. */
  invalid?: InvalidInput;
}

export interface SortOptions {
  /** Default throws `InvalidArgument` with the field name. */
  invalid?: InvalidInput;
}

const throwInvalidArgument: InvalidInput = (field, message) => {
  throw new InvalidArgument(message, field);
};

const describe = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** A number, or a query-string value of digits; `undefined` when absent. */
function integer(value: unknown, field: string, min: number, invalid: InvalidInput): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) {
    return invalid(field, `${field} must be an integer >= ${min}, got ${describe(value)}`);
  }
  return n;
}

/**
 * `{ limit, offset }` from paging input: `{ limit, offset }` (admin queries, query strings) or
 * `{ limit, page }` with a zero-based page index (`PaginationDTO`). Numbers and digit strings are
 * accepted; a missing limit takes the default, a too large one is clamped to the max, and
 * `limit < 1`, a negative or fractional value, or both `offset` and `page` are invalid.
 */
export function readPage(input: unknown, options: PageOptions = {}): Page {
  const invalid = options.invalid ?? throwInvalidArgument;
  const maxLimit = options.maxLimit ?? MAX_PAGE_LIMIT;
  const defaultLimit = Math.min(options.defaultLimit ?? DEFAULT_PAGE.limit, maxLimit);

  if (input === undefined || input === null) return { limit: defaultLimit, offset: DEFAULT_PAGE.offset };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return invalid('page', `page must be { limit, offset } or { limit, page }, got ${describe(input)}`);
  }

  const p = input as { limit?: unknown; offset?: unknown; page?: unknown };
  const limit = Math.min(integer(p.limit, 'limit', 1, invalid) ?? defaultLimit, maxLimit);
  const offset = integer(p.offset, 'offset', 0, invalid);
  const index = integer(p.page, 'page', 0, invalid);
  if (offset !== undefined && index !== undefined) return invalid('offset', 'give either offset or page, not both');

  return { limit, offset: offset ?? (index ?? 0) * limit };
}

/**
 * `{ column, order }` from sorting input (`OrderDTO`): a column outside `sortable` is invalid,
 * a missing one is `fallback.column`; the order is normalised to upper case, missing is `fallback.order`.
 */
export function readSort(input: { column?: unknown; order?: unknown } | undefined, sortable: readonly string[], fallback: { column: string; order?: SortOrder }, options: SortOptions = {}): Sort {
  const invalid = options.invalid ?? throwInvalidArgument;

  const column = input?.column;
  if (column !== undefined && column !== null && column !== '' && (typeof column !== 'string' || !sortable.includes(column))) {
    return invalid('column', `Cannot sort by ${describe(column)}. Sortable columns are: ${sortable.join(', ')}`);
  }

  const order = input?.order;
  if (order !== undefined && order !== null && order !== '' && (typeof order !== 'string' || !/^(asc|desc)$/i.test(order))) {
    return invalid('order', `order must be ASC or DESC, got ${describe(order)}`);
  }

  return {
    column: (column as string | undefined) || fallback.column,
    order: order ? ((order as string).toUpperCase() as SortOrder) : (fallback.order ?? SortOrder.ASC),
  };
}
