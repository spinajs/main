# `@spinajs/openapi`

`manifestToOpenApi(manifest, options)` turns an `app.manifest.json` produced by `spinajs build`
into an OpenAPI 3.1 document. Response schemas come from the manifest's derived schemas, so every
route with a declared return type has an exact `200` schema. Error responses use `application/problem+json`.

Routes a controller inherits are documented on the controller, under its path, with the types it binds (`ArticlesController extends BaseCrud<ArticleDto>` documents `GET /articles/{id}` returning `ArticleDto`, as `Articles_get`). A controller replaced with an unconditional `DI.register(Sub).as(Base)` is left out, because the runtime mounts only the subclass. A registration inside `bootstrap()`, a function, a loop or a `try` is conditional: both controllers stay, so on a path both serve generation fails with `duplicate operation` and `spinajs doctor` reports HTTP001. Register an override at module top level.

Options: `title`, `version`, `servers`, `securitySchemes` (the first scheme becomes the document-wide `security`; `security` overrides it; anonymous operations keep `security: []`), `basePath`, `routePrefix`, `errorSchema`/`errorSchemaId` (default: the built-in RFC 9457 `ProblemDetails`).

CLI: `spinajs generate:openapi --manifest app.manifest.json --out openapi.json`.

Guides: [`docs/openapi`](../../docs/openapi/README.md).
