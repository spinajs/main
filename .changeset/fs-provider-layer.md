---
"@spinajs/fs": minor
---

`FsProviderLayer`: a registered layer decides what a lookup of a provider by name hands out (`getFs`, `provider()`, `@FileSystem()`); `layeredFs()` applies the registered layers in registration order, the root container's before a child container's. Without a layer nothing changes; `publishedFs()` answers the published provider. A layer class replaced with `register(Sub).as(Layer)` runs as `Sub`. A layer that DI would skip (a factory, an instance, a `@NewInstance()` class, also as a replacement) or that resolves asynchronously makes the lookup throw `InvalidOperation` instead of handing out the published provider.
