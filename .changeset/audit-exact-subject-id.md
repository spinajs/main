---
"@spinajs/audit-orm": patch
"@spinajs/orm-mysql": patch
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
---

Trail reads and erasures match a subject type and id byte for byte on every dialect. Before, MySQL and SQL Server compared `subject_type` and `subject_id` with trailing spaces ignored: `forget({ type, id: 'ABC' })` (and `Model.history().forget('ABC')`) irreversibly blanked the payloads of the subject `'ABC '` as well, and `forget('ABC ')` those of `'ABC'`; a type `'invoice '` was erased with `'invoice'`; `of`, `asOf`, `since` and every read by subject or type listed the other spelling's events. The table reader, the outbox buffer and the archive consumer now match with `whereExactly()`, so the `(subject_type, subject_id, seq)` and `(subject_type, seq)` indexes are still used.

New where-builder method `whereExactly(column, value)` (`@spinajs/orm`, compiled by `@spinajs/orm-sql`'s `SqlExactlyStatement`): `(column = ? AND <SqlExpressions.equalsExactly()>)`, byte for byte on every dialect, trailing spaces included, and still an index seek on `column`. Available on select, update and delete builders and inside nested `where()` callbacks, qualified by the query's table alias.

Behaviour change on SQL Server: an id is matched as the database returns it. A `char(n)` key is recorded padded to `n` (as PostgreSQL always did), so `Model.history().of('AB')`, `asOf('AB', at)` and `forget('AB')` of a `char(5)` key now find nothing, and `forget` returns 0; before, SQL Server matched `'AB'` to `'AB   '`. Pass the padded key, as the database returns it, or use `row.history()`.

On MySQL `equalsExactly(left, right)` is now `CAST(left AS BINARY) = CAST(right AS BINARY)`: the former `left = CAST(right AS BINARY)` matched trailing-space look-alikes again when the same query also held a plain `left = ?`, because MySQL substitutes that constant for the column.
