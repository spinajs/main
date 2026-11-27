---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

Keyset pages of a query with a top-level `OR` now return each row once. Before, the predicate that starts a page past the cursor was joined to the query's conditions without a group: `Item.where('title', 'a').orWhere('title', 'b').paginate(...)` compiled its second page to `title = ? OR title = ? AND ( ( id > ? ) )`, so every row matching `title = 'a'` came back on every page; `paginate()` repeated rows across pages and `stream()` never ended where it pages by keyset (a SQLite database without WAL read handles, a driver without a cursor, every driver inside a transaction or under session settings). Now the conditions are grouped and the predicate is ANDed after them: `( title = ? OR title = ? ) AND ( ( id > ? ) )`, behind the soft-delete and archive filters on a model that has them. The SQL of such pages changes (brackets); a query without a top-level `OR` compiles to the same SQL as before.
