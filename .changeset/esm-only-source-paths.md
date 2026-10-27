---
"@spinajs/di": major
---

Package config `system.dirs.*` entries, the configuration file source and ORM migration discovery read `lib/` only. `__esmMode__` is no longer read anywhere; `DI.setESMModuleSupport()` is a deprecated no-op (remove the call). `currentBuildMigrationDir()` is removed from `@spinajs/orm`. If your app overrides a `system.dirs` entry with a `lib/mjs` path, drop the `mjs` segment.

Since the 4.0 module loader always uses `import()`, every installed package config loads in every process, as it always did in an app that called `DI.setESMModuleSupport()`. The file source therefore loads a config file reached through more than one directory once, at the last place it is reached, so project dirs still override package configs (a workspace package's own `lib/config` is also reached through its `node_modules` symlink). The `MaxAgeTempCleanupStrategy` interval no longer keeps a process alive.
