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
| `appRootOf(manifest, cwd)` | App root: `SPINAJS_MANIFEST_ROOT` if set (even when `app.root` exists), else `app.root` when it exists on this machine, else `cwd`. |

`outDir` (relative to the package root, default `lib`) is recorded per package in `package.outDir` and `packages[].outDir`, and for the app in `app.outDir`. It comes from the `outDir` of the package's tsconfig.

`package.configFiles` and `packages[].configFiles` list the package's built config files relative to its `outDir` (`config/log.js`, `config/log.production.js`), collected by the compiler from `src/config/**`. With a manifest, `@spinajs/configuration` loads these instead of globbing `node_modules/@spinajs/*/lib/config`: the same files, at the same place in the merge and in the same order, so the merged configuration is the one the walk gives. A manifest whose fragment predates the field globs that package's one config dir. Like the walk, only `@spinajs/*` packages contribute config files.

A manifest built on one machine and run on another (container image, bundle) keeps working when `app.root` no longer exists there: the working directory is used, or set `SPINAJS_MANIFEST_ROOT` to the deployed app directory. Every manifest-backed source resolves files through `manifestFileFor`, so the remap applies to config files, controllers, migrations and reflection alike, with the root containment and hash checks unchanged.

The `system.manifest` configuration section (`path`, default `app.manifest.json`; `mode`, default `off`) selects the file and the mode; it is defined by `SYSTEM_CONFIGURATION_SCHEMA` in `@spinajs/configuration`.

### Single-file bundle

`packages/http-socket-example` shows an esbuild bundle that boots in `require` mode from a directory with no `node_modules` at all (`npm run bundle`, output in `dist/bundle`):

- `main.mjs` holds the app and every dependency. It sets `SPINAJS_MANIFEST_ROOT` and `SPINAJS_MANIFEST` to its own directory, so the manifest built from the source tree still verifies.
- `package-roots.json` maps each listed package to a directory under the bundle (`packages/<name>`); `main.mjs` points `SPINAJS_PACKAGE_ROOTS` at it. See "Package roots" below.
- Package config files are separate small bundles at `packages/<pkg>/<outDir>/config/`, because the configuration source imports them by path. They are standalone module copies, not part of `main.mjs`: safe while they are plain data, but a config file that imports stateful modules would get its own instance of them.
- `main.mjs` defaults `SPINAJS_MANIFEST_MODE` to `require`; the DI loader refuses a file under the bundle root that it did not bundle.
- Controller, socket controller, schedule and migration files the manifest lists are inlined into `main.mjs` and handed to the runtime's import by path through the DI module loader (`__module_loader__`), so they are the same module instances as the app's own imports.
- `typescript` is replaced by a stub that throws on use: manifest mode does not call it.

### Package roots

`SPINAJS_PACKAGE_ROOTS` is an opt-in for apps that ship without `node_modules`: it names a JSON file mapping a package name to a directory relative to the app root (`{ "@spinajs/http": "packages/@spinajs/http" }`). `packageRootOf` consults it first, so config files, controllers, migrations and reflection all find the package through the same resolve. A mapped directory that leaves the app root (lexically or through a symlink) is refused; every file still goes through `manifestFileFor`, with its containment checks, and the manifest hash is verified as before. A package that is not in the map, or whose directory does not exist, is located the usual way: a listed package that is not installed is skipped, and a missing direct dependency fails `require` mode. Without the variable nothing changes.

### One switch

`ManifestConfigurationSource` (`@spinajs/configuration`, Order 0) decides the effective `system.manifest` once per configuration load, before any package config file loads:

1. `SPINAJS_MANIFEST_MODE` and `SPINAJS_MANIFEST` (environment) win;
2. then `system.manifest` from the app's own config dirs (`src/config`, `lib/config`, `config`, the app and custom dirs; common file, then the `APP_ENV` file). These are read before anything else, without the `node_modules` walk; a JS file is imported without running its `onConfigLoad`;
3. then the defaults.

It registers the result under `MANIFEST_SETTINGS` and the loaded manifest under `MANIFEST` (`MANIFEST_TOKEN`), and the final configuration's `system.manifest` is set to the result, whatever a later source or `onLoad` merged there. The file sources, `ListFromFiles` / `ResolveFromFiles` (`@spinajs/reflection`) and the http and orm sources read `manifestSettingsOf(container)` / `activeManifestOf(container)`; socket contract enforcement (`@spinajs/http-socket`) and `SwaggerService` (`@spinajs/http-swagger`) read `effectiveManifestOf(container)`, which falls back to the `system.manifest` key and the file it names only in an app whose container holds no decision (built without the configuration source); contract testing (`@spinajs/testing`) defaults to the manifest the app container registered; a `system.manifest` key that reaches the configuration any other way switches nothing. An unknown key in the app's `system.manifest` is logged as a warning (the schema then drops it). Only the environment and the app's config files set the switch; a `system.manifest` from another source (a static or remote source, `onLoad`) is replaced by the effective value.

At runtime `system.dirs.*` does not narrow what the manifest sources return: `spinajs build` decided what the manifest lists (see [The app's own classes](#the-apps-own-classes)). They sort it like a directory scan does (`glob`'s locale-aware order, migrations with the unsuffixed files first), so load order is the same in both modes, although the compiler sorts by code unit to keep hashes stable.

`ListFromFiles` and `ResolveFromFiles` map `configPath` to a manifest section (`MANIFEST_SECTIONS`: `system.dirs.controllers`, `socketControllers`, `schedules`, `cli`, `migrations`), or take it from `options.manifest`. The default mapping applies only without a `typeMatcher`. They read the scanned dirs from the root container's Configuration, and the manifest and its mode from the decorated instance's container lineage.

In tests, `withManifest(manifest, mode = 'prefer')` from `@spinajs/testing` registers both for `createTestApp({ register })`. A decision registered in the container's own registry before the configuration loads (this helper, or a host) wins over all three steps above and is kept with its manifest, also for apps built from a `FrameworkConfiguration` subclass.

### What changes when you switch manifest mode on

Check these before you set `prefer` or `require` (`off` changes none of them):

- **Sources come from the manifest.** Controllers, socket controllers, schedules, CLI commands, migrations and `@spinajs/*` config files are taken from the manifest instead of scanning directories. A class the last `spinajs build` did not record is not loaded: rebuild the manifest after code changes. In `require`, a missing manifest fails the boot.
- **Route parameter names come from the manifest.** `ManifestControllerMetadata` answers for every controller the manifest lists, so `typescript` is not loaded to parse controller declarations. In `require`, a controller with a source file that the manifest does not list fails registration with `NoControllerMetadata`; in `prefer` it falls back to the TypeScript cache. See [Controller cache and CLI](../http/21-controller-cache-and-cli.md#metadata-providers).
- **Request arguments are validated against derived schemas.** An argument without an explicit schema (`route.Schema`, the decorator's, the class `@Schema`) is checked against the schema derived from its TypeScript type: wrong types, literal unions and enums, and `NaN` numbers answer 400, and nested objects and single body fields reject undeclared properties. Constraints written only in a removed `@Schema` (`format`, `minLength`, `pattern`) are not derived; keep the `@Schema` or add JSDoc tags. See [Validation from the manifest](../http/04-route-arguments.md#validation-from-the-manifest).
- **Query, path and header values are coerced.** Handlers of `@QueryField()`, `@ParamField()`, `@HeadersField()` and object-typed `@Query()` get the derived types instead of strings: `query.exact === 'true'` turns `false`, because `exact` is now the boolean `true`, `?ids=7` becomes `[7]`, and a repeated scalar (`?page=1&page=2`) answers 400.
- **Decorator metadata becomes optional.** Argument types (`@Body() dto: Dto`, `@Param() id: number`), socket `@Payload` types and the types of `@Autoinject()` / `@LazyInject()` properties that name none come from the manifest (`TypeRef.ref`, `propertyInjects[].tokenRef`) when the build emits no `design:*` metadata. See [Building without decorator metadata](#building-without-decorator-metadata).
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

The manifest holds what discovery finds. A dependency's fragment (built with `declaredDirsOnly`, as `scripts/build-fragments.mjs` does) lists a controller, socket controller, schedule, command or migration only when its file is under a `system.dirs.*` dir that the package's own config declares for that section; classes outside them are registered by importing the package (migrations, `AccessPushSocket`) or by an opt-in subpath (`@spinajs/upload/scheduler`), or are not served at all. Abstract classes are never listed.

### The app's own classes

`spinajs build` checks the app's controllers, socket controllers, schedules, CLI commands and migrations against the `system.dirs.*` the app runs with. A class discovery never loads is not loaded from the manifest in `prefer` or `require` either. These five are the sections discovery scans; models and queue messages have no `system.dirs` scan and stay as they are.

1. The CLI boots `Configuration` and reads `system.dirs`. That value holds the app's config for this `APP_ENV` and the dirs `--app`, `--apppath` and `--config-path` add. An empty `system.dirs.migrations` falls back to the dirs the orm scans in that case (`defaultMigrationDirs()`).
2. It hands them to the compiler as data (`buildAppManifest({ effectiveDirs, defaultDirs, requireAppDirs })`); the compiler never evaluates config. Each dir maps back to the sources through the `tsconfig` `outDir` and `rootDir`, so `lib/controllers` becomes `src/controllers`. A dir above the `outDir` or the `rootDir` covers all sources. A dir outside the app, such as a package's, or one with no source folder behind it, maps nothing.
3. A scan imports every file under a section's dirs, at any depth. Each section then has its own rule for what that brings in, and the build applies it:

| Section | What discovery serves |
| --- | --- |
| Controllers, CLI commands | A class a file under the dirs **exports at runtime**, wherever it is declared. A barrel, `export *` and `export const Served = X` count, with the module rules for a name collision: a local export wins over a star, and two stars with different classes export neither. A non-exported class does not count, and neither do the forms that emit nothing: `export type { X }`, `export type *`, `export { type X }`, and `export { X }` of an `import type` |
| Schedules, socket controllers, migrations | A class in **any file that import loads**: under the dirs, or reached from there by an import that survives compilation. These register themselves as their module is evaluated, so an export is not needed. An import used only as a type is elided, and brings nothing in |

File names count too, as in a scan. Every section but migrations matches `.ts` and `.js` files that are not `.d`, so a `.json` or `.mts` file under a dir is not scanned. A migrations dir matches a name with no dot, or one ending in `.<env>` compared literally with the normalized `APP_ENV`, whatever the rest looks like: `legacy.old.ts`, `helper.util.ts` and `Foo_2026_07_29_10_00_00.test.ts` belong to environments called `old`, `util` and `test`. The environment is known only at boot, so the manifest applies that test there, to entries and scan files alike, and such a file stays out of every other environment. A migration that only a tagged file imports gets `mountedBy`, because it must not load in the others.

| The class | In the manifest | Loaded from the manifest | Reported |
| --- | --- | --- | --- |
| Discovery serves it, by the rule of its section | Yes | Yes | No |
| Anything else | Yes, with `mountedBy: 'di'` | No | `CMP006` warning: class, file, dirs searched |

An entry with `mountedBy` keeps the class's metadata, but nothing imports the class for it. It runs only if something registers it, exactly as in discovery: an import that runs its decorators, `DI.register(X).as(BaseController)` that is really reached, `@Injectable(BaseController)` in a file something imports, your own `ControllerSource`, `Controllers.add()`. The compiler cannot tell whether that happens, so a registered class still gets `CMP006`. When it does run, the runtime finds its entry for parameter names, types without decorator metadata, request validation and socket contracts, and `require` accepts it. Entries that share a class name, such as an abandoned copy of a live controller, are told apart by the class's own file, so a flagged copy does not disturb the live class.

A scan also imports files with no class of their own, and those run: `src/controllers/register.ts` with `DI.register(X).as(BaseController)`, or `src/schedules/index.ts` with `import '../elsewhere/Task.js'`. The manifest lists them in `scanFiles`, per section, and importing a section imports them too, unless the file was not built. Only the app's own `scanFiles` count.

A class in a module that does not export it, in the three sections that register on import, is recorded with `exported: false`. Any other listed class missing from its module means a stale manifest and fails with `ManifestMissing`, in all five sections: rebuild.

The build does not follow `await import()`, because such a call may never run. A class only that loads gets `CMP006`, and it still runs when the call does: the entry keeps its metadata, so only the warning is wrong.

| What reads the manifest | Entries with `mountedBy` |
| --- | --- |
| `ManifestControllerSource`, `listFromManifest` (socket controllers, schedules, commands, migrations) | Skipped: this is what keeps the class unloaded |
| `ManifestControllerMetadata`, the runtime type fill, request validation, socket contracts | Read: a route a registration serves is typed and validated as any other |
| `spinajs doctor` | Read: a route a registration serves must stay guarded, so its rules report these too |
| `generate:openapi`, `generate:client`, `generate:asyncapi` | Left out: nothing static can tell that the registration runs. The Swagger UI of `@spinajs/http-swagger` lists what is really mounted, so it shows a class that is served |
| `manifest:diff` | Left out of routes, migrations and the other contract sections, so a change to such a route is not reported there, and moving a registered class out of the dirs shows as a breaking removal. A change to its permissions is reported, not breaking, and marked as conditional |

**When no dir applies.** What the build does depends on whether the config it read names any folder of the app:

| Case | Result |
| --- | --- |
| Some section's configured dirs map into the app | The config was read. A section with no dir is empty: its classes get `mountedBy`, each with `CMP006` |
| No configured dir of any section maps into the app, and the app has at least one class in the five sections | The build stops with `CMP007`, exit code 1, and writes nothing, naming what it searched. The orm's default migration dirs do not count: they exist without any config. Usual causes: `lib/config` is not compiled, the build runs from another folder, or it lacks the `--app`, `--apppath` or `--config-path` the app runs with |
| The same, with `--allow-no-dirs` | For an app that really declares no dirs. The build goes on and every class except those under the default migration dirs gets `mountedBy`: nothing loads from the manifest, as nothing loads in discovery |
| No class in the five sections | Nothing to filter, so the build goes on: a config-only app of framework packages needs no dirs |

**The manifest reflects the config of the build's `APP_ENV`.** A config file of another environment (`*.prod.js`) that adds a dir counts only in a build under that environment. Run `spinajs build` with the `APP_ENV` (or `--env`) and the `--app`, `--apppath` and `--config-path` of the deployment, after compiling: the CLI reads `lib/config`, not `src/config`.

**Run it from the folder the app runs from.** `system.dirs` is usually computed from `process.cwd()`, so the build warns with `CLI001` when that is not the `tsconfig` folder. It is a warning and not a refusal, because an app that runs from its build folder gets the right dirs only from there. A configured dir of the app with no source folder behind it gets `CMP008`, so a partly wrong working directory shows as more than per-class warnings. Paths are compared physically, so a release folder behind a symlink maps either way, and `manifest.app.root` holds the physical path. A manifest carried from one release folder to the next keeps pointing at the old one while that folder exists: set `SPINAJS_MANIFEST_ROOT` in such a layout.

**The CLI sees only what it can read.** `--app`, `--apppath` and `--config-path` stand in for the `app`, `appBaseDir` and `cfgCustomPaths` options. A value an app sets only in code (those options passed to `FrameworkConfiguration`, `configuration.set()`, a `Configuration` subclass) does not reach the build: pass the matching option, or put the value in a config file.

A direct call of `buildAppManifest` without `effectiveDirs` marks nothing.

### Building without decorator metadata

An app that boots in `prefer` or `require` can compile with `"emitDecoratorMetadata": false` (`experimentalDecorators` stays on). The compiler records what the metadata would have held: `TypeRef.ref` on route arguments and socket payloads, and `tokenRef` on property injections that name no type (see [Runtime types](../compiler/README.md#runtime-types)). At boot:

- `@spinajs/http` types each argument whose `RuntimeType` is missing before the routes are built, so validation, the scalar schemas and DTO hydration behave as with metadata. `@spinajs/http-socket` does the same for `@Payload` before the handlers register.
- `@spinajs/di` records an `@Autoinject()` or `@LazyInject()` property without a type as pending. When the owner is resolved, the container asks the property type resolver that `@spinajs/configuration` registers with the manifest decision; the first resolution of such an owner can be asynchronous, because the class file is imported then.
- `resolveTypeRef(ref, manifest)` imports every referenced file through `manifestFileFor` (root containment), memoised per manifest.

In `off` mode nothing is filled: arguments stay untyped, and a property without a type throws `ResolveException` naming the class and the property. In `require` an argument or payload the manifest cannot type fails the boot; in `prefer` it stays untyped with a warning. A type the manifest cannot reference (`TYP001`, `TYP002`), an `@Autoinject(X)` on an array property, and a socket `@FromDI()` argument still need an explicit type.
