---
"@spinajs/idempotency": minor
---

`OrmIdempotencyStore` keeps idempotency keys in the `__idempotency` table (migration `Idempotency_2026_11_12_00_00_00` on the connection alias `idempotency`, mapped to `default`). A claim is an ignore-on-duplicate insert or a conditional take-over of an ended lease, so a taken key never fails a statement. A claim made inside a transaction joins it; when concurrent claims there deadlock (MySQL) or fail a REPEATABLE READ / SERIALIZABLE check (Postgres), the database rolls the transaction back and `claim` throws the retryable `IdempotencyClaimConflict`. `ormModelRegistered(container)` reports whether the Orm resolved with the table's model.
