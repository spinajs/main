import 'mocha';
import { expect } from 'chai';
import type { CursorPage, CursorQuery, Page, PageQuery } from '../src/index.js';

describe('pagination types', () => {
  it('describe the reply and query shapes of a paginated route', () => {
    const page: Page<{ id: number }> = { items: [{ id: 1 }], total: 1 };
    const last: CursorPage<string> = { items: ['a'], next: null };
    const offset: PageQuery = { page: 1, pageSize: 20 };
    const cursor: CursorQuery = { cursor: 'c1', pageSize: 20 };
    expect([page.total, last.next, offset.page, cursor.cursor]).to.deep.equal([1, null, 1, 'c1']);
  });
});
