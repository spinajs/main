---
"@spinajs/di": major
---

Package config `system.dirs.*` entries, the configuration file source and ORM migration discovery read `lib/` only. `__esmMode__` is no longer read anywhere; `DI.setESMModuleSupport()` is a deprecated no-op (remove the call). `currentBuildMigrationDir()` is removed from `@spinajs/orm`. If your app overrides a `system.dirs` entry with a `lib/mjs` path, drop the `mjs` segment.
