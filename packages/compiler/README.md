# @spinajs/compiler

Build-time analyzer that reads a package's TypeScript source through its `tsconfig` and emits a `ManifestFragment` (services, controllers, routes, models, migrations, schedules, CLI commands, queue messages and more). `analyzePackage` produces the fragment for one package; `buildAppManifest` merges the application fragment with the fragments shipped by its dependencies (found through `package.json#spinajs.manifest`) into `app.manifest.json`. The analyzer uses the in-process TypeScript 5.9 API (pinned `~5.9.0`) and never executes user code.

Extraction rules, the fragment contract and the diagnostics are documented in [docs/compiler](../../docs/compiler/README.md):

| Codes | About |
| --- | --- |
| `CMP001` to `CMP005` | Values the analyzer could not read (decorator arguments, `@response` tags, dynamic conditions, exception statuses, hydrated route arguments, token keys) |
| `CMP006` to `CMP008`, `CLI001` | `spinajs build` and the app's `system.dirs`: classes not loaded from the manifest, no dir maps to the app, a dir with no source folder, the wrong working directory |
| `TYP001`, `TYP002` | Runtime types the manifest cannot reference |
| `CFG010` | A configuration schema that is not a literal |
| `SCH001` to `SCH006` | JSON Schema derivation and explicit `@Schema` arguments |

`runDoctor` adds the rules of [spinajs doctor](../../docs/compiler/doctor.md): `DI001` to `DI003`, `HTTP001` to `HTTP006`, `CFG001` to `CFG004`, `BLD001`, `ORM001`, `SCH003`, `SOCK001` to `SOCK006` and `WF001` to `WF003`.
