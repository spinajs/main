# @spinajs/manifest

Versioned types, JSON Schema and helpers for the application manifest (`manifestVersion: 2`; version 1 fragments, whose `fullPath` and parameter `kind` values mean something else, are refused). See the package README for the reader, hash and merge helpers.

## Runtime

`@spinajs/manifest` exports a runtime that boots read from instead of scanning directories. It adds no dependency: it uses `node:fs`, `node:path`, `node:module` and the package own validator.

| Export | Purpose |
| --- | --- |
| `MANIFEST_TOKEN` | `'__manifest__'`, the DI key the loaded manifest is registered under. |
| `loadRuntimeManifest({ path, mode }, cwd?)` | Reads and validates the manifest. `off` never reads; `prefer` returns `undefined` when the file is missing; `require` throws `ManifestMissing`. Relative paths resolve against `cwd`. |
| `manifestFileFor(entry, manifest, cwd)` | Built `.js` file of an entry: `src/x/y.ts` of package P becomes `<root of P>/<outDir>/x/y.js`. |
| `packageRootOf(name, manifest, cwd)` | Install root (real path) of a package listed in `manifest.packages`: `node_modules/<name>` of the nearest ancestor of the app root that has it, as node resolves it, also for an ESM-only package whose `exports` hide `package.json`; Node resolution is the fallback. |
| `appRootOf(manifest, cwd)` | App root: `SPINAJS_MANIFEST_ROOT` if set, else `app.root` when it exists on this machine, else `cwd`. |

`outDir` (relative to the package root, default `lib`) is recorded per package in `package.outDir` and `packages[].outDir`, and for the app in `app.outDir`. It comes from the `outDir` of the package's tsconfig.

`package.configFiles` and `packages[].configFiles` list the package's built config files relative to its `outDir` (`config/log.js`, `config/log.production.js`), collected by the compiler from `src/config/**`. With a manifest, `@spinajs/configuration` loads these instead of globbing `node_modules/@spinajs/*/lib/config`: the same files, at the same place in the merge and in the same order, so the merged configuration is the one the walk gives. A manifest whose fragment predates the field globs that package's one config dir. Like the walk, only `@spinajs/*` packages contribute config files.

A manifest built on one machine and run on another (container image, bundle) keeps working when `app.root` no longer exists there: the working directory is used, or set `SPINAJS_MANIFEST_ROOT` to the deployed app directory.

The `system.manifest` configuration section (`path`, default `app.manifest.json`; `mode`, default `off`) selects the file and the mode; it is defined by `SYSTEM_CONFIGURATION_SCHEMA` in `@spinajs/configuration`.

### One switch

`ManifestConfigurationSource` (`@spinajs/configuration`, Order 0) decides the effective `system.manifest` once per configuration load, before any package config file loads:

1. `SPINAJS_MANIFEST_MODE` and `SPINAJS_MANIFEST` (environment) win;
2. then `system.manifest` from the app's own config dirs (`src/config`, `lib/config`, `config`, the app and custom dirs; common file, then the `APP_ENV` file). These are read before anything else, without the `node_modules` walk; a JS file is imported without running its `onConfigLoad`;
3. then the defaults.

It registers the result under `MANIFEST_SETTINGS` and the loaded manifest under `MANIFEST` (`MANIFEST_TOKEN`), and the final configuration's `system.manifest` is set to the result, whatever a later source or `onLoad` merged there. The file sources, `ListFromFiles` / `ResolveFromFiles` (`@spinajs/reflection`) and the http and orm sources read `manifestSettingsOf(container)` / `activeManifestOf(container)`; socket contract enforcement (`@spinajs/http-socket`) and `SwaggerService` (`@spinajs/http-swagger`) read `effectiveManifestOf(container)`, which falls back to the `system.manifest` key and the file it names only in an app whose container holds no decision (built without the configuration source); contract testing (`@spinajs/testing`) defaults to the manifest the app container registered; a `system.manifest` key that reaches the configuration any other way switches nothing. An unknown key in the app's `system.manifest` is logged as a warning (the schema then drops it). Only the environment and the app's config files set the switch; a `system.manifest` from another source (a static or remote source, `onLoad`) is replaced by the effective value.

The manifest lists every controller, migration and so on of the app and its listed packages: `system.dirs.*` does not narrow what the manifest sources return. They sort it like a directory scan does (`glob`'s locale-aware order, migrations with the unsuffixed files first), so load order is the same in both modes, although the compiler sorts by code unit to keep hashes stable.

`ListFromFiles` and `ResolveFromFiles` map `configPath` to a manifest section (`MANIFEST_SECTIONS`: `system.dirs.controllers`, `socketControllers`, `schedules`, `cli`, `migrations`), or take it from `options.manifest`. The default mapping applies only without a `typeMatcher`. They read the scanned dirs from the root container's Configuration, and the manifest and its mode from the decorated instance's container lineage.

In tests, `withManifest(manifest, mode = 'prefer')` from `@spinajs/testing` registers both for `createTestApp({ register })`. A decision registered in the container's own registry before the configuration loads (this helper, or a host) wins over all three steps above and is kept with its manifest, also for apps built from a `FrameworkConfiguration` subclass.

### What changes when you switch manifest mode on

Check these before you set `prefer` or `require` (`off` changes none of them):

- **Sources come from the manifest.** Controllers, socket controllers, schedules, CLI commands, migrations and `@spinajs/*` config files are taken from the manifest instead of scanning directories. A class the last `spinajs build` did not record is not loaded: rebuild the manifest after code changes. In `require`, a missing manifest fails the boot.
- **Route parameter names come from the manifest.** `ManifestControllerMetadata` answers for every controller the manifest lists, so `typescript` is not loaded to parse controller declarations. In `require`, a controller with a source file that the manifest does not list fails registration with `NoControllerMetadata`; in `prefer` it falls back to the TypeScript cache. See [Controller cache and CLI](../http/21-controller-cache-and-cli.md#metadata-providers).
- **Request arguments are validated against derived schemas.** An argument without an explicit schema (`route.Schema`, the decorator's, the class `@Schema`) is checked against the schema derived from its TypeScript type: wrong types, literal unions and enums, and `NaN` numbers answer 400, and nested objects and single body fields reject undeclared properties. Constraints written only in a removed `@Schema` (`format`, `minLength`, `pattern`) are not derived; keep the `@Schema` or add JSDoc tags. See [Validation from the manifest](../http/04-route-arguments.md#validation-from-the-manifest).
- **Query, path and header values are coerced.** Handlers of `@QueryField()`, `@ParamField()`, `@HeadersField()` and object-typed `@Query()` get the derived types instead of strings: `query.exact === 'true'` turns `false`, because `exact` is now the boolean `true`, `?ids=7` becomes `[7]`, and a repeated scalar (`?page=1&page=2`) answers 400.
- **Undeclared root keys of a whole body are dropped from the argument.** A DTO built from a whole body (`@Body()` as the only body argument, `@BodyField()`) gets only its declared root keys; read others (`reauthPassword`, a CSRF token) from `req.body`, which stays as sent.

### Runtime modes

| `system.manifest.mode` | Behaviour |
| --- | --- |
| `off` (default) | Directory scans and the `node_modules/@spinajs/*` config walk, as before. The manifest is never read. |
| `prefer` | Uses the manifest when the file exists, falls back to discovery for everything it lacks. |
| `require` | The manifest is the only source of controllers, migrations, schedules, socket controllers and CLI commands. A missing manifest or section fails the boot with `ManifestMissing`. |

Environment overrides: `SPINAJS_MANIFEST_MODE` and `SPINAJS_MANIFEST` (the file) beat the app's config; `SPINAJS_MANIFEST_ROOT` names the deployed app directory when `app.root` does not exist on the machine that runs it.

With a manifest in `require` mode the boot skips: the `node_modules/@spinajs/*` config walk (package config files come from `packages[].configFiles`; set `WORKSPACE_ROOT_PATH` to skip the hoisting-root detection too), the controller, migration, schedule, socket controller and CLI command directory scans, the `.d.ts` parsing of the controller cache, and the `typescript` load. `glob` is still imported by `@spinajs/configuration`, `@spinajs/orm`, `@spinajs/validation` and `@spinajs/intl`, and the app's own `config/` dirs are still globbed.

`packages/compiler/test/e2e/boot-from-manifest.test.ts` proves this on the `app-basic` fixture: it installs the compiled fixture next to only the `@spinajs` packages it depends on, boots it in `require` mode in a fresh process, and compares what it serves with a `off` boot that scans. The manifest lists every controller and migration of the closure, so two things differ from discovery: `@spinajs/tasks` contributes its migration, which discovery registers only once something imports that package, and controllers a dedicated source gates (`static mountedBySource`) are left to that source.
