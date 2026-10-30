---
"@spinajs/configuration": minor
---

`ManifestConfigurationSource` (Order 0) loads the package config defaults the manifest lists and registers the manifest under `MANIFEST` (`__manifest__`); the file sources then skip the `node_modules/@spinajs/*` walk. `SPINAJS_MANIFEST` and `SPINAJS_MANIFEST_MODE` override `system.manifest`. `WORKSPACE_ROOT_PATH` detection and the package config dirs are computed on first use instead of in the constructor, and `src/config` now merges after the package defaults like the other project dirs.
