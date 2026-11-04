import type { Finding } from './schema-compare.js';
import type { RouteEntry } from './types.js';

/**
 * A client pages through the route by `pagination`, so losing it or changing its kind breaks the client's infinite queries.
 * Gaining it is not breaking on its own: the reply schema comparison reports the shape change, such as an array becoming a page.
 */
export function comparePagination(b: RouteEntry, h: RouteEntry): Finding[] {
  const before = b.pagination?.kind;
  const after = h.pagination?.kind;
  if (before === after) return [];
  if (!before) return [{ breaking: false, detail: `now paginated (${after})` }];
  if (!after) return [{ breaking: true, detail: `no longer paginated (was ${before})` }];
  return [{ breaking: true, detail: `pagination changed from ${before} to ${after}` }];
}
