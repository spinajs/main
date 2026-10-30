---
"@spinajs/reflection": minor
"@spinajs/testing": minor
---

`ListFromFiles` and `ResolveFromFiles` list classes from the runtime manifest section named by `configPath` (or the new `options.manifest`) instead of globbing directories when `system.manifest.mode` is `prefer` or `require`; `require` without a manifest throws `ManifestMissing`. `@spinajs/testing` adds `withManifest(manifest)` for `createTestApp({ register })`.
