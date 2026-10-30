# `@spinajs/openapi`

`manifestToOpenApi(manifest, options)` turns an `app.manifest.json` produced by `spinajs build`
into an OpenAPI 3.1 document. Response schemas come from the manifest's derived schemas, so every
route has an exact `200` schema. Error responses use `application/problem+json`.

Paths are the request paths the router answers (`RouteEntry.fullPath`); pass `routePrefix` with the
app's `http.controllers.route.prefix`. Parameters and request bodies follow `ParamEntry.wire`:

| `wire` | OpenAPI |
| --- | --- |
| `value` in query/path/header/cookie | parameter with the derived `schema` |
| `json` in query/path/header/cookie | parameter with `content: { 'application/json': { schema } }` |
| `whole` query (`@QueryField`) | one `form` parameter per DTO property |
| `whole` body (`@Body`, `@BodyField`, `@RawBody`, `@FromXml`) | request body is the DTO schema |
| `field` body | one object request body keyed by the field names |
| `multipart` | `multipart/form-data` object; `multiple` is an array of parts |
| `none` | omitted (injected by the framework) |

A parameter without `wire` throws: the manifest was built by a compiler that does not record it.

CLI: `spinajs generate:openapi --manifest app.manifest.json --out openapi.json`.

Guides: [`docs/openapi`](../../docs/openapi/README.md).
