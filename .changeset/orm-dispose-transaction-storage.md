---
"@spinajs/orm": patch
---

`Orm.dispose()` disables the transaction `AsyncLocalStorage` of each connection, through the new `OrmDriver.releaseTransactionStorage()`. On Node 22 an enabled storage is visited for each new promise of the process, so every disposed driver went on slowing the process down.
