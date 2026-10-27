---
"@spinajs/orm": major
---

`OrmConfigurationBootstrapper` is removed. It re-registered the `db.*` configuration schema after `DI.clearCache()`; the schema registered at import now survives `clearCache()` on its own.
