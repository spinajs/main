---
"@spinajs/openapi": minor
"@spinajs/cli": minor
---

New `@spinajs/openapi` package: `manifestToOpenApi(manifest, options)` turns `app.manifest.json` into a deterministic OpenAPI 3.1 document with exact responses, `application/problem+json` errors and the `x-authz-*` extensions. `spinajs generate:openapi` writes it to a file.
