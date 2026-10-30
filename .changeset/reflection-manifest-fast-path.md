---
"@spinajs/reflection": minor
"@spinajs/testing": minor
---

`ListFromFiles` and `ResolveFromFiles` list classes from the runtime manifest section named by `configPath` (or the new `options.manifest`) instead of globbing directories when the effective `system.manifest.mode` (decided by `ManifestConfigurationSource`, see `manifestSettingsOf`) is `prefer` or `require`; `require` without a manifest throws `ManifestMissing`. `@spinajs/testing` adds `withManifest(manifest, mode)` for `createTestApp({ register })`.
