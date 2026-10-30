---
"@spinajs/reflection": minor
---

`listFromManifest` reads the switch through `effectiveManifestOf` and no longer takes a `mode`; `manifestMode` is removed. `ListFromFiles` / `ResolveFromFiles` cache their result per effective manifest settings, so an app booted later with another mode lists again instead of reusing the first app's listing.
