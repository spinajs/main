---
"@spinajs/configuration": minor
---

`ManifestConfigurationSource` (Order 0) registers the runtime manifest under `MANIFEST` (`__manifest__`). With a manifest, the file sources take the package config files from `manifest.packages[].configFiles` instead of globbing `node_modules/@spinajs/*/lib/config`, at the same place and in the same order, so the merged configuration equals the one the walk gives. Without a manifest nothing changes. `SPINAJS_MANIFEST` and `SPINAJS_MANIFEST_MODE` override `system.manifest`.
