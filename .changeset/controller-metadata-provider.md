---
"@spinajs/http": minor
---

Route parameter names and controller documentation come from a `ControllerMetadataProvider`: `ManifestControllerMetadata` answers for the controllers the effective manifest lists, `CacheControllerMetadata` falls back to the TypeScript controller cache. `DefaultControllerCache` moved to the `@spinajs/http/cache` subpath and is imported on first use; it imports `typescript` only on a cache miss, so a pre-built cache or a manifest boots without the compiler. An argument under a decorator the compiler does not record keeps the name the handler declares. `glob`, which `@spinajs/http` never imported, is no longer a dependency. In `require` mode a controller with a source file that the manifest does not list throws `NoControllerMetadata`.
