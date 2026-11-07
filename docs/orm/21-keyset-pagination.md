# Keyset pagination

`query.paginate()` returns one page and opaque cursors to the pages next to it. Unlike `skip()`, it does not shift or repeat rows when rows are inserted or deleted between two page requests, and its cost does not grow with the page number.

```ts
const page = await Order.where('Status', 'open').paginate({ orderBy: [['CreatedAt', 'desc']], limit: 50 });
// page.items, page.next, page.previous
const following = await Order.where('Status', 'open').paginate({ orderBy: [['CreatedAt', 'desc']], limit: 50, after: page.next! });
```

- `orderBy` lists columns and directions; directions may be mixed. The primary key is appended as the tie-breaker, so equal values never split or repeat across pages.
- `after: next` continues forward. `before: previous` goes back. `next` is `null` on the last page and `previous` is `null` on the first.
- A cursor is base64url JSON of the order values of the row it was made from, plus a hash of the order. A cursor used with another `orderBy`, or one that does not decode, throws `InvalidCursor`. `InvalidCursor` is an `InvalidArgument`, so `@spinajs/http` answers it with 400 `application/problem+json`.
- The cursor is spec-checked, not signed. The hash names the order it was made for and carries no secret, so a client can craft a start position; that only moves the start of the page, and the query's own `where()` still bounds the rows a page can reach. Do not rely on a cursor to hide rows: put the restriction in the query.
- Order columns must be NOT NULL. A column the model describes as nullable throws `InvalidArgument` before the first page is fetched. A NULL in the row a cursor is made from throws `InvalidOperation`.
- The query must not have its own `order()`, `take()`, `skip()` or `first()`. `paginate()` sets them and executes the query. `distinct()`, `groupBy()`, an aggregate column and an order by a relation column are refused too (`InvalidOperation`).
- Rows present for the whole walk appear exactly once. Rows inserted during the walk appear when they sort after the current position.
