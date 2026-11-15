/**
 * A page of an offset-paginated list. The compiler marks a route as paginated only by this alias's declaration, so a
 * structurally equal type declared elsewhere is not marked.
 */
export type Page<T> = { items: T[]; total: number };

/** A page of a cursor-paginated list; `next` is the cursor of the following page, `null` on the last one. */
export type CursorPage<T> = { items: T[]; next: string | null };

/** `page` counts from 1 unless its schema says `minimum: 0`. */
export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface CursorQuery {
  cursor?: string;
  pageSize?: number;
}
