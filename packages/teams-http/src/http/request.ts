import type { Page } from '@spinajs/teams';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Fresh objects: http-swagger rewrites the schema nodes it walks.
export const pageQuery = () => ({ type: 'integer', minimum: 0, description: 'page number from 0 (default 0)' });
export const sizeQuery = () => ({ type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, description: `page size (default ${DEFAULT_PAGE_SIZE})` });

/** `@Query` validated `page` and `size` against the schemas above; absent ones take the defaults. */
export function pageOf(page?: number, size?: number): Page {
  const limit = size ?? DEFAULT_PAGE_SIZE;
  return Object.freeze({ limit, offset: (page ?? 0) * limit });
}

/** A copy without the undefined keys, so a service reading `'key' in input` sees only what the client sent. */
export function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
