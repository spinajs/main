# Keyset pagination

`query.paginate()` returns one page and opaque cursors to the pages next to it. Unlike `skip()`, it does not shift or repeat rows when rows are inserted or deleted between two page requests, and its cost does not grow with the page number.

```ts
const page = await Order.where('Status', 'open').paginate({ orderBy: [['CreatedAt', 'desc']], limit: 50 });
// page.items, page.next, page.previous
const following = await Order.where('Status', 'open').paginate({ orderBy: [['CreatedAt', 'desc']], limit: 50, after: page.next! });
```

- `orderBy` lists columns and directions; directions may be mixed. The primary key is appended as the tie-breaker, so equal values never split or repeat across pages.
- `after: next` continues forward. `before: previous` goes back. `next` is `null` on the last page and `previous` is `null` on the first. An empty page reached with `before` has `next` set to the cursor it was asked with.
- A cursor is base64url JSON of the order values of the row it was made from, plus a hash of the order. A cursor used with another `orderBy`, or one that does not decode, throws `InvalidCursor`. `InvalidCursor` is an `InvalidArgument`, so `@spinajs/http` answers it with 400 `application/problem+json`.
- Each decoded value must fit its column, read from the driver's dialect profile (`nativeTypes`): a safe integer for an integer column (32-bit unless the type also holds bigint), a whole number within int64 for a bigint column, a number or numeric string for decimal, a string for text and enum, a boolean for boolean, a datetime for date and datetime, a UUID string for uuid. A value that does not fit, or a cursor longer than 4096 characters, throws `InvalidCursor`; so does the next request after a page whose cursor grew past 4096 characters (a text order column of ~3 KB values). Only the family is checked: a range narrower than the family (pg `int2`, `float4`) still reaches SQL, and a mysql `INT UNSIGNED` key above 2^31 is refused as an integer. A column whose type the profile does not list is not checked.
- The cursor is spec-checked, not signed. The hash names the order it was made for and carries no secret, so a client can craft a start position; that only moves the start of the page, and the query's own `where()` still bounds the rows a page can reach. Do not rely on a cursor to hide rows: put the restriction in the query.
- Order columns must be NOT NULL. A column the model describes as nullable throws `InvalidArgument` before the first page is fetched. A NULL in the row a cursor is made from throws `InvalidOperation`.
- The query must not have its own `order()`, `take()`, `skip()` or `first()`. `paginate()` sets them and executes the query. `distinct()`, `groupBy()` and an aggregate column are refused too (`InvalidOperation`); an order by a relation column is an `InvalidArgument`.
- A query narrowed with `select()` or `columns()` gets the order columns and the primary key added to its column list, because the cursors are made from them. The rows carry those columns at runtime; the row type stays as narrowed.
- Rows present for the whole walk appear exactly once. Rows inserted during the walk appear when they sort after the current position.
