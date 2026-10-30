# `@spinajs/openapi`

`manifestToOpenApi(manifest, options)` turns an `app.manifest.json` produced by `spinajs build`
into an OpenAPI 3.1 document. Response schemas come from the manifest's derived schemas, so every
route with a declared return type has an exact `200` schema. Error responses use `application/problem+json`.

Options: `title`, `version`, `servers`, `securitySchemes` (the first scheme becomes the document-wide `security`; `security` overrides it; anonymous operations keep `security: []`), `basePath`, `routePrefix`, `errorSchema`/`errorSchemaId` (default: the built-in RFC 9457 `ProblemDetails`).

CLI: `spinajs generate:openapi --manifest app.manifest.json --out openapi.json`.

Guides: [`docs/openapi`](../../docs/openapi/README.md).
