---
"@spinajs/openapi": minor
"@spinajs/cli": patch
---

`manifestToOpenApi` documents the caching headers of a route from the `CacheControl` and `NoStore` references in the manifest: `Cache-Control` (with the value the middleware writes, when its arguments are literals), `Pragma` for `NoStore`, `Vary` from every declaration that runs, the `ETag` Express sends on replies with a body, and a `304` without a body on GET and HEAD routes. The new option `etag: false` leaves `ETag` and the 304 out for an app that runs with `http.etag: false`; `spinajs generate:openapi` sets it from the app's configuration. A committed `openapi.json` of an app that uses `CacheControl` or `NoStore` changes once.
