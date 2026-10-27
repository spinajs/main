---
"@spinajs/di": major
---

Package config `system.dirs.*` entries, the configuration file source and ORM migration discovery read `lib/` only. `__esmMode__` is no longer read anywhere; `DI.setESMModuleSupport()` is a deprecated no-op (remove the call). `currentBuildMigrationDir()` is removed from `@spinajs/orm`. If your app overrides a `system.dirs` entry with a `lib/mjs` path, drop the `mjs` segment.

With one `lib/` per package, a workspace package's own `lib/config` is both a project config dir and its `node_modules/@spinajs` package dir. The file source loads such a file once, at the last place it is reached, so it merges as a project config: in a workspace, a package's own shipped config now merges after the other packages' configs instead of at its alphabetical slot. Paths listed twice by overlapping globs keep their first listing. The `MaxAgeTempCleanupStrategy` interval no longer keeps a process alive.
