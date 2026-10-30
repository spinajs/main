---
"@spinajs/cli": major
"@spinajs/compiler": minor
"@spinajs/configuration": minor
"@spinajs/orm": patch
---

`spinajs build` lists an app's own controllers, socket controllers, schedules, commands and migrations only under the `system.dirs.*` the app runs with, so a class discovery never loads is no longer mounted in `prefer` and `require`. The CLI reads the effective dirs (the app's config for this `APP_ENV`, the `RunApp` dirs, the orm's default migration dirs) and hands them to `buildAppManifest({ effectiveDirs })` as data; the compiler still evaluates no config, and a call without them filters nothing. A dropped class is reported as a `CMP006` warning; a section with no dir in the app keeps its classes with a `CMP007` warning. A controller registered as `BaseController` stays listed, and one handed over as `<di>` by a source keeps working. `defaultMigrationDirs()` moves from `@spinajs/orm` to `@spinajs/configuration`; `DEFAULT_MIGRATION_DIRS` stays.
