# @spinajs/manifest

Versioned types, JSON Schema and helpers for the application manifest (`manifestVersion: 2`; version 1 fragments, whose `fullPath` and parameter `kind` values mean something else, are refused). See the package README for the reader, hash and merge helpers.

## Runtime

`@spinajs/manifest` exports a runtime that boots read from instead of scanning directories. It adds no dependency: it uses `node:fs`, `node:path`, `node:module` and the package own validator.

| Export | Purpose |
| --- | --- |
| `MANIFEST_TOKEN` | `'__manifest__'`, the DI key the loaded manifest is registered under. |
| `loadRuntimeManifest({ path, mode }, cwd?)` | Reads and validates the manifest. `off` never reads; `prefer` returns `undefined` when the file is missing; `require` throws `ManifestMissing`. Relative paths resolve against `cwd`. |
| `manifestFileFor(entry, manifest, cwd)` | Built `.js` file of an entry: `src/x/y.ts` of package P becomes `<root of P>/<outDir>/x/y.js`. |
| `packageRootOf(name, manifest, cwd)` | Install root of a package listed in `manifest.packages`, resolved the way node resolves it from the app root. |
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

It registers the result under `MANIFEST_SETTINGS` and the loaded manifest under `MANIFEST` (`MANIFEST_TOKEN`), and the final configuration's `system.manifest` is set to the result, whatever a later source or `onLoad` merged there. The file sources, `ListFromFiles` / `ResolveFromFiles` (`@spinajs/reflection`) and the http and orm sources read `manifestSettingsOf(container)` / `activeManifestOf(container)`; a `system.manifest` key that reaches the configuration any other way switches nothing. An unknown key in the app's `system.manifest` is logged as a warning (the schema then drops it). Only the environment and the app's config files set the switch; a `system.manifest` from another source (a static or remote source, `onLoad`) is replaced by the effective value.

`ListFromFiles` and `ResolveFromFiles` map `configPath` to a manifest section (`MANIFEST_SECTIONS`: `system.dirs.controllers`, `socketControllers`, `schedules`, `cli`, `migrations`), or take it from `options.manifest`. The default mapping applies only without a `typeMatcher`. They read the scanned dirs from the root container's Configuration, and the manifest and its mode from the decorated instance's container lineage.

In tests, `withManifest(manifest, mode = 'prefer')` from `@spinajs/testing` registers both for `createTestApp({ register })`.
