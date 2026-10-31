---
"@spinajs/cli": major
"@spinajs/compiler": major
"@spinajs/manifest": minor
"@spinajs/configuration": minor
"@spinajs/orm": patch
"@spinajs/reflection": minor
"@spinajs/openapi": minor
"@spinajs/asyncapi": minor
"@spinajs/client": minor
---

`spinajs build` checks an app's own controllers, socket controllers, schedules, commands and migrations against the `system.dirs.*` the app runs with. A class no file under its section's dirs exports stays in the manifest with `mountedBy: 'di'`, keeps its metadata, and is not loaded from the manifest: it runs only if something registers it, as in discovery. Such a class is reported as a `CMP006` warning. `doctor` keeps guarding its routes; generated documents and `manifest:diff` leave it out. The field is additive, `MANIFEST_VERSION` stays 2.

The CLI reads the effective dirs (the app's config for this `APP_ENV`, the `RunApp` dirs) and hands them to `buildAppManifest` as data, with the orm's default migration dirs apart; the compiler still evaluates no config, and a call without `effectiveDirs` marks nothing. A section with no dir is empty. A build where no configured dir maps into the app fails with `CMP007`, exit 1, and writes nothing; `--allow-no-dirs` builds a deliberate no-dirs app. A working directory other than the `tsconfig` folder warns with `CLI001`.

`--config-path` adds a config folder from the command line, as `cfgCustomPaths` does in code. `defaultMigrationDirs()` is new in `@spinajs/configuration`, and `DEFAULT_MIGRATION_DIRS` of `@spinajs/orm` now comes from it.
