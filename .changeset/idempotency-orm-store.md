---
"@spinajs/idempotency": minor
---

`OrmIdempotencyStore` keeps idempotency keys in the `__idempotency` table (migration `Idempotency_2026_11_12_00_00_00` on the connection alias `idempotency`, mapped to `default`). A claim is an ignore-on-duplicate insert or a conditional take-over of an ended lease, so it never fails a statement inside an open Postgres transaction. `ormModelRegistered(container)` reports whether the Orm resolved with the table's model.
