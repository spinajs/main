---
"@spinajs/orm-postgres": patch
---

`@spinajs/orm-postgres`: a client whose `ROLLBACK` failed is destroyed instead of returned to the pool, so a session that may still be inside the transaction, with its transaction-local settings, is never handed to the next request. The error the transaction threw is unchanged.
