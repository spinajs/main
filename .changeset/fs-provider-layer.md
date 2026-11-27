---
"@spinajs/fs": minor
---

`FsProviderLayer`: a registered layer decides what a lookup of a provider by name hands out (`getFs`, `provider()`, `@FileSystem()`); `layeredFs()` applies the registered layers. Without a layer nothing changes; `publishedFs()` answers the published provider. A layer registered as a factory or a `@NewInstance()` class makes the lookup throw `InvalidOperation` instead of being skipped.
