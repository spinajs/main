import type { Finding } from './schema-compare.js';
import type { PaginationParam, RouteEntry, RoutePagination } from './types.js';

const located = (param: PaginationParam): string => [param.arg, ...param.path].join('.');

/** Within one kind: the client pages by `param` from `firstPage`, so losing the one or moving the other breaks it. */
function comparePaging(before: RoutePagination, after: RoutePagination): Finding[] {
  if (!before.param) return [];
  if (!after.param) return [{ breaking: true, detail: `page parameter ${located(before.param)} removed: the client can no longer page through the route` }];
  const [from, to] = [before.firstPage ?? 1, after.firstPage ?? 1];
  return from === to ? [] : [{ breaking: true, detail: `first page changed from ${from} to ${to}` }];
}

/**
 * A client pages through the route by `pagination`, so losing it, changing its kind, losing the page parameter or moving
 * the first page breaks the client's infinite queries. Gaining it is not breaking on its own: the reply schema comparison
 * reports the shape change, such as an array becoming a page.
 */
export function comparePagination(b: RouteEntry, h: RouteEntry): Finding[] {
  const before = b.pagination;
  const after = h.pagination;
  if (!after) return before ? [{ breaking: true, detail: `no longer paginated (was ${before.kind})` }] : [];
  if (!before) return [{ breaking: false, detail: `now paginated (${after.kind})` }];
  if (before.kind !== after.kind) return [{ breaking: true, detail: `pagination changed from ${before.kind} to ${after.kind}` }];
  return comparePaging(before, after);
}
