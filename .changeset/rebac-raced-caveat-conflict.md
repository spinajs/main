---
"@spinajs/authz-rebac": patch
---

`DbTupleStore` refuses a tuple another transaction stored meanwhile with another caveat on MySQL too. The caveat of a raced tuple was compared with a plain read, which on MySQL keeps the transaction's snapshot and does not see the other writer's row: two writers adding the same tuple with different caveats both succeeded, and one caveat was silently lost. The raced tuples are now read under a shared row lock where the dialect has one (MySQL, PostgreSQL, PGlite), so the loser gets `TupleCaveatConflict` as on SQLite and PostgreSQL. A raced tuple the transaction still cannot read (PostgreSQL `REPEATABLE READ` or `SERIALIZABLE`, SQL Server `SNAPSHOT`) fails the write with `ConcurrencyConflict` of `@spinajs/exceptions`, to be retried, instead of passing unchecked.
