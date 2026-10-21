import { cursorWithOffset, decodeCursor, encodeCursor, invalidCursor } from '../../stores/cursor.js';
import type { ListResult, Page } from '../ports.js';

/**
 * Listing position of the rows of a memory store, so a cursor survives deletes and inserts: a cursor names
 * the sequence number of the last row read, not an index into the current rows.
 */
export class ListingOrder {
  private seqs = new Map<string, number>();
  private last = 0;

  note(id: string): void {
    if (!this.seqs.has(id)) this.seqs.set(id, ++this.last);
  }

  forget(id: string): void {
    this.seqs.delete(id);
  }

  /** Restores the positions as they are now; call it from a rollback. */
  snapshot(): () => void {
    const saved = new Map(this.seqs);
    return () => {
      this.seqs = saved;
    };
  }

  /** `items` in listing order. A page with an offset gets no `next`, as in the DB stores. */
  page<T extends { readonly id: string }>(items: readonly T[], page: Page | undefined, where: string): ListResult<T> {
    if (!page) return { items, total: items.length };
    let rest = items;
    if (page.after !== undefined) {
      if (page.offset > 0) throw cursorWithOffset(where);
      const [seq] = decodeCursor(page.after, 2, where);
      if (!/^\d+$/.test(seq)) throw invalidCursor(where);
      rest = items.filter((item) => (this.seqs.get(item.id) ?? 0) > Number(seq));
    }
    const from = page.after === undefined ? page.offset : 0;
    const slice = rest.slice(from, from + page.limit);
    const last = slice[slice.length - 1];
    const more = rest.length > from + page.limit;
    return { items: slice, total: items.length, ...(more && page.offset === 0 && last ? { next: encodeCursor(String(this.seqs.get(last.id) ?? 0), last.id) } : {}) };
  }
}
