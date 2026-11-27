---
"@spinajs/audit-orm": patch
"@spinajs/orm-mysql": patch
---

Trail reads and erasures match a subject id byte for byte on every dialect. Before, MySQL and SQL Server compared `subject_id` with trailing spaces ignored: `forget({ type, id: 'ABC' })` (and `Model.history().forget('ABC')`) irreversibly blanked the payloads of the subject `'ABC '` as well, and `forget('ABC ')` those of `'ABC'`; `of`, `asOf` and every read by subject listed the other id's events. The table reader, the outbox buffer and the archive consumer now add `SqlExpressions.equalsExactly()` beside the indexed equality, so the `(subject_type, subject_id, seq)` index is still used.

On MySQL `equalsExactly(left, right)` is now `CAST(left AS BINARY) = CAST(right AS BINARY)`: the former `left = CAST(right AS BINARY)` matched trailing-space look-alikes again when the same query also held a plain `left = ?`, because MySQL substitutes that constant for the column.
