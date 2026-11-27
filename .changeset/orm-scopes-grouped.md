---
"@spinajs/orm": minor
"@spinajs/orm-sql": patch
"@spinajs/authz-orm": patch
---

A query with a top-level `OR` on a `@SoftDelete` or `@Archived` model no longer returns deleted or archived rows. Before, the `DeletedAt IS NULL` / `ArchivedAt IS NULL` filters were joined with the query's conditions without a group: `Task.where('title', 'a').orWhere('title', 'd')` compiled to `deleted_at IS NULL AND archived_at IS NULL AND title = ? OR title = ?` and returned the deleted `d`; `Task.query().orWhere('id', 4)` returned every live row and the deleted row 4; a raw `whereRaw('… OR 1 = 1')` returned every row of the table. With `.accessible()` the authz filter still bound, but deleted rows the principal may read came back. Now the filters are ANDed with the conditions as one group: `deleted_at IS NULL AND archived_at IS NULL AND ( title = ? OR title = ? )`. A query whose conditions have no top-level `OR` compiles to the same SQL as before. Code that relied on reading deleted or archived rows through an `OR` must call `withDeleted()` / `withArchived()`. For example `@spinajs/users` `getUser('<email or login>')` (`User.whereAnything()`, the `users:find` command) no longer finds a soft-deleted user; it never did by id or uuid. Query with `User.query().withDeleted()` to reach a deleted account.

`withDeleted()` and `withArchived()` now remove only the filter the model added. A `whereNull('DeletedAt')` the query writes itself stays; before, `withDeleted()` removed it too.

authz-orm's runtime guard reads the same grouping: `Task.query().orWhere('id', 't1')` (and its `first()` and `selectCount()`) reads one row and is a single-object load; a `where('id', 't1').orWhere(...)` that can read more rows is still flagged.
