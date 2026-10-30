---
"@spinajs/configuration": major
"@spinajs/authz-convert": patch
---

A config array the app sets now replaces the default instead of being concatenated to it. `http.socket.transports: ['websocket']` in an app config is `['websocket']`, not `['websocket', 'polling', 'websocket']`.

- Package config files (`node_modules/@spinajs/*/lib/config`, or the manifest's `configFiles`) and `__configuration__` DI values still concatenate their arrays.
- The app's own config files (an environment file over a common file too), `onLoad()`, every other `ConfigurationSource` and `mergeSource()` replace an array.
- The arrays in `COMPOSED_CONFIG_ARRAYS` concatenate in every merge: `system.dirs.*`, `fs.providers`, `queue.connections`, `http.Static`, `logger.filters`, the arrays of an RBAC role, `authz.rbac.serviceRoles.*`, `authz.abac.policies`, `authz.admin.guard.keepHolders`, `authz.fields.neverRead`, `validation.strict.idPrefixes` and every `__file__`.
- `merge(path, value)` still concatenates, and now also appends to an array stored at `path` itself instead of overwriting it index by index.
- New exports: `mergeConfig(target, source, 'concat' | 'replace')`, `COMPOSED_CONFIG_ARRAYS`, `ArrayMerge`. `BaseFileSource.configFiles()` returns `{ file, arrays }` entries, and `load()` takes an optional object to merge into.

`@spinajs/authz-convert` keeps reading an app's config files with the 3.x rule (every array concatenates).

See `docs/upgrading/4.0.md`, "Config arrays replace the default".
