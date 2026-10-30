---
"@spinajs/configuration": major
"@spinajs/authz-convert": patch
---

A config array the app sets now replaces the default instead of being concatenated to it. `http.socket.transports: ['websocket']` in an app config is `['websocket']`, not `['websocket', 'polling', 'websocket']`.

- Package config files (`node_modules/@spinajs/*/lib/config`, or the manifest's `configFiles`) and `__configuration__` DI values still concatenate their arrays.
- `__configuration__` DI values are package defaults: they lead the package layer, in Node and in the browser. A scalar that used to win over `onLoad()` and every source now loses to the app. Use `set()` for a runtime override.
- The app's own config files, `src/config` included, sit above every package file of every format and pass, for arrays and scalars, and replace an array. An environment file replaces its common file. `onLoad()`, every other `ConfigurationSource` and `mergeSource()` replace an array, in `Order`, so a `StaticConfigurationSource` at its default `Order` loses to the package default.
- The arrays in `COMPOSED_CONFIG_ARRAYS` concatenate in every merge: `system.dirs.*`, `fs.providers`, `queue.connections`, `http.Static`, `logger.filters`, the `grants`, `extends` and `revoke` of an RBAC role, `authz.rbac.serviceRoles.*`, `authz.abac.policies`, `authz.admin.guard.keepHolders`, `authz.fields.neverRead`, `validation.strict.idPrefixes` and every `__file__`.
- `merge(path, value)` still concatenates, and now also appends to an array stored at `path` itself instead of overwriting it index by index.
- New exports: `mergeConfig(target, source, 'concat' | 'replace')`, `isComposedConfigArray`, `COMPOSED_CONFIG_ARRAYS`, `ArrayMerge`, `ConfigLayers`, `LayeredConfigurationSource`. `BaseFileSource.configFiles()` returns `{ file, arrays }` entries, `loadLayers()` is new, and `projectConfigDirs()` returns one list.

`@spinajs/authz-convert` keeps reading an app's config files with the 3.x rule (every array concatenates) and writes the joined list into each env file that sets an array, because 4.x replaces it there. Regenerate env files written by an earlier version.

See `docs/upgrading/4.0.md`, "Config arrays replace the default".
