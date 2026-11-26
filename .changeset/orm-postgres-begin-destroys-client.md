---
"@spinajs/orm-postgres": patch
---

`@spinajs/orm-postgres`: when `SET TRANSACTION ISOLATION LEVEL` (or `BEGIN`) fails while a transaction opens, the client is destroyed instead of returned to the pool. Before, the next statement on that pooled client failed with "current transaction is aborted".
