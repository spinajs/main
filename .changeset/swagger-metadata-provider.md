---
"@spinajs/http-swagger": minor
---

`SwaggerDocCache` reads controller documentation through the `@spinajs/http` `ControllerMetadataProvider`s: from the manifest for the controllers it lists, from the TypeScript cache otherwise. Policy descriptions still come from the cache. `http:swagger:cache` logs a deprecation and does nothing when a manifest is in effect.
