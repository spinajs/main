---
"@spinajs/http": minor
---

Route parameter names and controller documentation come from a `ControllerMetadataProvider`: `ManifestControllerMetadata` answers for the controllers the effective manifest lists, `CacheControllerMetadata` falls back to the TypeScript controller cache. `DefaultControllerCache` moved to the `@spinajs/http/cache` subpath and is imported on first use, so `typescript` is loaded only when the cache is needed; `typescript` and `glob` are optional peer dependencies. In `require` mode a controller with a source file that the manifest does not list throws `NoControllerMetadata`.
