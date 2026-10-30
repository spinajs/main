---
"@spinajs/fs": patch
---

`fsService.dispose()` removes the providers it published from `'__file_provider_instance__'`: the map is a DI value now and outlives `clearCache()`, so `getFs()` would otherwise keep serving a disposed service's providers.
