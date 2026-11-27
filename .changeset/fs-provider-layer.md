---
"@spinajs/fs": minor
---

`FsProviderLayer`: a registered layer decides what a lookup of a provider by name hands out (`getFs`, `provider()`, `@FileSystem()`); `layeredFs()` applies the registered layers in registration order, the root container's before a child container's. Without a layer nothing changes; `publishedFs()` answers the published provider. A layer class replaced with `register(Sub).as(Layer)` runs as `Sub`. `fsService.resolve()` resolves the registered layers last, so a layer dependency that fails fails the boot. A layer that DI would skip (a factory, an instance, a `@NewInstance()` class, also as a replacement, or one registered with `asValue()`), one that resolves asynchronously, or one whose `wrap()` returns a promise makes the lookup throw `InvalidOperation` instead of handing out the published provider.
