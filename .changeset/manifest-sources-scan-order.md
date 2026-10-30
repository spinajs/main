---
"@spinajs/configuration": patch
"@spinajs/reflection": minor
---

`ManifestConfigurationSource` keeps a manifest decision that is already registered in the container's own registry (a host, or `withManifest` in tests) instead of replacing it at boot. `@spinajs/reflection` exports `inScanOrder`, which sorts listed classes the way a directory scan does.
