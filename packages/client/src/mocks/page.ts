export interface MockPageOptions {
  /** Default: `pageSize`, one full page. */
  total?: number;
  /** Default: `firstPage`. */
  page?: number;
  /** Default 20. */
  pageSize?: number;
  /** The index of the first page, 0 or 1 as the route counts; default 1. */
  firstPage?: number;
}

export interface MockCursorPageOptions {
  /** Default 20. */
  count?: number;
  /** Default `null`, the last page. */
  next?: string | null;
}

function count(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`mockPage: ${name} must be a non-negative integer, got ${value}`);
  return value;
}

/** One offset page, `{ items, total }`; `item(i)` gets the index of the item across all pages. */
export function mockPage<T>(item: (i: number) => T, opts: MockPageOptions = {}): { items: T[]; total: number } {
  const pageSize = count('pageSize', opts.pageSize ?? 20);
  const total = count('total', opts.total ?? pageSize);
  const firstPage = count('firstPage', opts.firstPage ?? 1);
  const page = count('page', opts.page ?? firstPage);
  const start = Math.max(0, page - firstPage) * pageSize;
  const length = Math.max(0, Math.min(pageSize, total - start));
  return { items: Array.from({ length }, (_, j) => item(start + j)), total };
}

/** One cursor page, `{ items, next }`. */
export function mockCursorPage<T>(item: (i: number) => T, opts: MockCursorPageOptions = {}): { items: T[]; next: string | null } {
  const length = count('count', opts.count ?? 20);
  return { items: Array.from({ length }, (_, i) => item(i)), next: opts.next ?? null };
}
