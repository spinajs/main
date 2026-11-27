---
"@spinajs/authz-abac": patch
---

`AbacModel.invalidate()` called inside a transaction (a store answers `inTransaction()` with `true`) no longer starts a background reload there: that reload read through the transaction and was kept, so a permit the transaction then rolled back kept granting (SQLite, PostgreSQL), and under PostgreSQL `REPEATABLE READ` a policy deleted and committed meanwhile kept granting from the transaction's older snapshot. Now the next check outside a transaction starts the reload; until then every pair routes to the model and checks inside a transaction read the stores themselves. A store without `inTransaction()` still starts the reload at once.
