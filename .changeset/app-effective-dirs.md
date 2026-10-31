---
"@spinajs/cli": major
"@spinajs/compiler": major
"@spinajs/manifest": minor
"@spinajs/configuration": minor
"@spinajs/orm": minor
"@spinajs/reflection": minor
"@spinajs/http": minor
"@spinajs/http-socket": minor
"@spinajs/openapi": minor
"@spinajs/asyncapi": minor
"@spinajs/client": minor
---

`spinajs build` checks an app's own controllers, socket controllers, schedules, commands and migrations against the `system.dirs.*` the app runs with, by each section's own discovery rule. Controllers and commands count when a file under the dirs exports them at runtime, so a type-only re-export does not count. Schedules, socket controllers and migrations count when importing those files loads them, exported or not. Anything else stays in the manifest with `mountedBy: 'di'`, keeps its metadata, and is not loaded from the manifest: it runs only if something registers it, as in discovery. Such a class is reported as a `CMP006` warning. `doctor` keeps guarding its routes; generated documents leave it out; `manifest:diff` reports only its permission changes, as non-breaking. `scanFiles` lists the files a scan imports that no loaded entry brings in, so side-effect files run too. Both fields are additive, `MANIFEST_VERSION` stays 2: rebuild the manifest after upgrading, because an older one keeps mounting everything it lists.

The CLI reads the effective dirs (the app's config for this `APP_ENV`, the `RunApp` dirs) and hands them to `buildAppManifest` as data, with the orm's default migration dirs apart; the compiler still evaluates no config, and a call without `effectiveDirs` marks nothing. A section with no dir is empty. A build where no configured dir maps into an app that has classes in these sections fails with `CMP007`, exit 1, and writes nothing; `--allow-no-dirs` builds a deliberate no-dirs app. A working directory other than the `tsconfig` folder warns with `CLI001`, and a configured dir with no source folder behind it with `CMP008`.

Entries that share a class name are told apart by the class's own file through `ownEntries` in `@spinajs/manifest`, so a flagged copy does not disturb the live class; `@SocketController` records its `SourceFile` for that. `--config-path` adds a config folder from the command line, as `cfgCustomPaths` does in code, and `parseArgv` reads the `--name=value` form of every framework option. `defaultMigrationDirs()` is new in `@spinajs/configuration`, and `DEFAULT_MIGRATION_DIRS` of `@spinajs/orm` now comes from it.
