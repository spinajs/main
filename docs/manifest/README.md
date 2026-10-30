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
- **Decorator metadata becomes optional.** Argument types (`@Body() dto: Dto`, `@Param() id: number`), socket `@Payload` and `@FromDI()` types and the types of `@Autoinject()` / `@LazyInject()` properties that name none come from the manifest (`TypeRef.ref`, `diArgs`, `classProperties`) when the build emits no `design:*` metadata. See [Building without decorator metadata](#building-without-decorator-metadata).
- **Undeclared root keys of a whole body are dropped from the argument.** A DTO built from a whole body (`@Body()` as the only body argument, `@BodyField()`) gets only its declared root keys; read others (`reauthPassword`, a CSRF token) from `req.body`, which stays as sent.

### Runtime modes

| `system.manifest.mode` | Behaviour |
| --- | --- |
| `off` (default) | Directory scans and the `node_modules/@spinajs/*` config walk, as before. The manifest is never read. |
| `prefer` | Uses the manifest when the file exists, falls back to discovery for everything it lacks. |
| `require` | The manifest is the only source of controllers, migrations, schedules, socket controllers and CLI commands. A missing manifest or section fails the boot with `ManifestMissing`. |

Environment overrides: `SPINAJS_MANIFEST_MODE` and `SPINAJS_MANIFEST` (the file) beat the app's config; `SPINAJS_MANIFEST_ROOT` names the deployed app directory when `app.root` does not exist on the machine that runs it.

With a manifest in `require` mode the boot skips: the `node_modules/@spinajs/*` config walk (package config files come from `packages[].configFiles`; set `WORKSPACE_ROOT_PATH` to skip the hoisting-root detection too), the controller, migration, schedule, socket controller and CLI command directory scans, the `.d.ts` parsing of the controller cache, and the `typescript` load. `glob` is still imported by `@spinajs/configuration`, `@spinajs/orm`, `@spinajs/validation` and `@spinajs/intl`, and the app's own `config/` dirs are still globbed.

`packages/compiler/test/e2e/boot-from-manifest.test.ts` proves this on the `app-basic` fixture: it installs the compiled fixture next to only the `@spinajs` packages it depends on, boots it in `require` mode in a fresh process, and compares what it serves with an `off` boot that scans. Both boots serve the same controllers, schedules, commands, socket commands and migrations; only the order of the migrations differs (discovery lists the app's dir first, the manifest by package).

The manifest holds what discovery finds. The app's own classes are all listed (abstract bases excepted). A dependency's fragment (built with `declaredDirsOnly`, as `scripts/build-fragments.mjs` does) lists a controller, socket controller, schedule, command or migration only when its file is under a `system.dirs.*` dir that the package's own config declares for that section; classes outside them are registered by importing the package (migrations, `AccessPushSocket`) or by an opt-in subpath (`@spinajs/upload/scheduler`), or are not served at all. Abstract classes are never listed.

### Building without decorator metadata

An app that boots in `prefer` or `require` can compile with `"emitDecoratorMetadata": false` (`experimentalDecorators` stays on). Set it in the tsconfig `spinajs build` reads: `classProperties` is recorded only then. The compiler records what the metadata would have held (see [Runtime types](../compiler/README.md#runtime-types)). At boot:

- `@spinajs/configuration` imports every class `classProperties` names, at the end of `Configuration.resolve()`, so the first resolve of a sync service stays sync. A class that cannot load fails the boot in `require` and is logged in `prefer`. These imports are the one thing a build without metadata does earlier than a build with it: a class file that resolves `Configuration` with a top-level `await` would wait for itself.
- `@spinajs/http` types each argument whose `RuntimeType` is missing before the routes are built, so validation, the scalar schemas and DTO hydration behave as with metadata. `@spinajs/http-socket` does the same for `@Payload` and `@FromDI()` before the handlers register. Both fill a copy: the class descriptor stays as decorated, several boots in one process do not share what they filled, and the routes a boot serves are `BaseController.Routes`.
- A route a controller inherits is looked up along its class chain, in `controllers` and then `controllerBases`. Request validation finds it the same way, with metadata too. Socket handlers do the same with `socketControllerBases`, for types, derived payload schemas and contract checks.
- `@spinajs/di` collects every property decorated without metadata. After `Configuration`, after the controllers load, in `Orm.resolve()` and before socket handlers register, a `require` boot fails listing every one the table lacks, and `prefer` logs a named error for each. That is the signal for a build compiled without metadata from a tsconfig that says otherwise. A class that loads later still fails when its owner is resolved. The list is process-wide, as decorators are, and the table belongs to one manifest: a test process with classes its manifest does not list, or two apps with different manifests in one process, call `forgetPendingProperties(owner?)` from `@spinajs/di` before the boot (see [createTestApp](../testing/01-create-test-app.md#building-without-decorator-metadata)).
- `@spinajs/di` records an `@Autoinject()` or `@LazyInject()` property as pending. When the owner is resolved, the container asks the property type resolver that `@spinajs/configuration` registers with the manifest decision, for the type and for whether the property is a list: `@Autoinject(X)` on an array or `Map` property injects the list, as with metadata.
- `resolveTypeRef(ref, manifest)` imports every referenced file through `manifestFileFor` (root containment), memoised per manifest.

What happens when the manifest has no answer:

| Case | `require` | `prefer` | `off`, or no manifest |
| --- | --- | --- | --- |
| A route argument, `@Payload` or `@FromDI()` it cannot type, or whose entry describes another argument | fails the boot, with the reason when the compiler recorded one | logs a named error, stays untyped | logs a named error, stays untyped (a `@Payload` is read as a plain object) |
| An `@Autoinject()` / `@LazyInject()` property the table does not list | fails the boot, listing them | logs a named error at boot; `ResolveException` when the owner is resolved | `ResolveException` when the owner is resolved |
| An `@Autoinject(X)` / `@LazyInject(X)` property the table does not list | fails the boot, listing them | logs a named error at boot, injects one instance, even for a list | injects one instance, even for a list |
| An `@Autoinject(X)` / `@LazyInject(X)` list resolved before `Configuration` | fails the boot, listing them | logs a named error at boot, keeps the one instance | injects one instance |
| Two classes of one name, in any packages, that declare the property differently | `ResolveException` | `ResolveException` | |

The runtime knows a class by name alone. Two classes of one name that declare a property alike are fine; rename one otherwise, or pass the type to the decorator.

**Order: `Configuration` comes first.** The manifest is read inside `Configuration.resolve()`, and the property types are ready when it returns. A class with a property that names no type cannot be resolved before that, in any mode: not a `Bootstrapper`, which the entry point resolves first, nor a class your `main` resolves before `Configuration`, nor a `ConfigurationSource`. Such a class throws `ResolveException` saying so. Pass the type to the decorator (`@Autoinject(Dep)`), or resolve `Configuration` first.

A type passed to the decorator works at any time for a single class only. Whether a property is a list comes from the manifest too, so `@Autoinject(Plugin) list: Plugin[]` resolved before `Configuration` gets one instance. The check after `Configuration` then fails a `require` boot, or logs a named error in `prefer`, naming the property. Resolve `Configuration` first, or state the list with `@Autoinject(Array.ofType(Plugin))`.

An argument of a kind that never reads its type (`@Req`, `@Res`, `@Ip`, `@RequestId`, `@UserAgent`, `@Referer`, `@RawBody`, `@AcceptType`, `@RequestStream`, `@ContentDigest`) never fails a boot: an annotation the manifest cannot name records `Object`. Any other argument typed by a class of a package without a manifest fragment, such as luxon's `DateTime` on `@Query()`, fails `require`: name the class with `@Type(DateTime)`.

Models work too. `@HasMany`, `@HasManyToMany`, `@Virtual` and `@JunctionTable` read the class the property declares from `classProperties` when a relation is first built, because a model file loads before the boot. `@AutoinjectService` is typed like `@Autoinject()`. Two things stay different without metadata:

- `@CreatedAt`, `@UpdatedAt`, `@SoftDelete`, `@Archived`, `@DateTime`, `@Bool` and `@Set` use the type only to refuse a wrong one when the class is defined. Without metadata that check does not run: `@Bool() x: string` loads, and gets the boolean converter.
- A property under a decorator of your own has a row with its list shape and no type, because the compiler knows the decorators by name. A wrapper around `Autoinject(Dep)` works, a list too. A wrapper that names no class throws `ResolveException` when its owner is resolved, or when a relation is first built.

Relations read the root container, as the ORM does elsewhere, so an app in an isolated child container with its own manifest needs `withManifest` to hold it in root.

`packages/compiler/test/e2e/boot-from-manifest.test.ts` boots `app-basic` compiled with `emitDecoratorMetadata: false` in `require`, in a separate process, and compares what it serves with the build that has metadata. `orm-no-metadata.test.ts` does the same for a timestamped model with relations against sqlite.
