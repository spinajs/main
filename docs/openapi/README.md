# `@spinajs/openapi`

`manifestToOpenApi(manifest, options)` turns an `app.manifest.json` produced by `spinajs build`
into an OpenAPI 3.1 document. Response schemas come from the manifest's derived schemas, so every
route has an exact `200` schema. Error responses use `application/problem+json`.

CLI: `spinajs generate:openapi --manifest app.manifest.json --out openapi.json`.

Guides: [`docs/openapi`](../../docs/openapi/README.md).
