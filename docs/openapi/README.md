# `@spinajs/openapi`

`manifestToOpenApi(manifest, options)` turns an `app.manifest.json` produced by `spinajs build` into an OpenAPI 3.1 document. It is a pure function: no DI, no filesystem, deterministic output. Response schemas come from the manifest's derived schemas, so every route with a declared return type has an exact `200` schema. Error responses use `application/problem+json`.

Routes a controller inherits are documented on the controller, under its path, with the types it binds (`ArticlesController extends BaseCrud<ArticleDto>` documents `GET /articles/{id}` returning `ArticleDto`, as `Articles_get`). A controller replaced with an unconditional `DI.register(Sub).as(Base)` is left out, because the runtime mounts only the subclass. A registration inside `bootstrap()`, a function, a loop or a `try` is conditional: both controllers stay, so on a path both serve generation fails with `duplicate operation` and `spinajs doctor` reports HTTP001. Register an override at module top level.

Options: `title`, `version`, `servers`, `securitySchemes` (the first scheme becomes the document-wide `security`; `security` overrides it; anonymous operations keep `security: []`), `basePath`, `routePrefix`, `errorSchema`/`errorSchemaId` (default: the built-in RFC 9457 `ProblemDetails`).

## Install

```sh
npm install --save-dev @spinajs/openapi @spinajs/cli @spinajs/compiler
```

`@spinajs/openapi` is an optional peer of `@spinajs/cli`; without it `generate:openapi` fails with `install @spinajs/openapi to use generate:openapi`. `@spinajs/compiler` is needed for `spinajs build`, which writes the manifest the generator reads.

## Generate a document

```sh
spinajs build
spinajs generate:openapi --title "Notes API" --doc-version 1.2.0 --server-url http://localhost:4557
# OpenAPI document written to <absolute path>/openapi.json
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Manifest to read |
| `-o, --out <path>` | `openapi.json` | File to write; missing folders are created |
| `--title <title>` | the app name | `info.title` |
| `--doc-version <version>` | `1.0.0` | `info.version` |
| `--server-url <url>` | none | One entry in `servers` |
| `--base-path <path>` | none | Literal prefix for every path, for example where a proxy mounts the app |
| `--route-prefix <prefix>` | `http.controllers.route.prefix` of the configuration | The prefix the router applies |

A route served only by a registration (a manifest entry with `mountedBy`) is left out: nothing static says that the registration runs.

### Sample output

The `app-basic` fixture of the compiler tests has a `HealthController` and a `UsersController`. Its document, with title `app-basic`, version `1.0.0` and server `http://localhost:4557`, is committed as `packages/openapi/test/__snapshots__/app-basic.openapi.json`; the test fails when the output differs. An excerpt, with the snapshot's indented JSON folded to fewer lines:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "app-basic",
    "version": "1.0.0",
    "x-spinajs-manifest-hash": "e8c022b23448e14475f69d3729820cfbaea3f5b1db9cb43d4a0d1c760eae2f21"
  },
  "servers": [{ "url": "http://localhost:4557" }],
  "tags": [{ "name": "Health" }, { "name": "Users" }],
  "paths": {
    "/health/get": {
      "get": {
        "operationId": "Health_get",
        "tags": ["Health"],
        "parameters": [],
        "responses": {
          "200": {
            "description": "Successful response",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/HealthController_get_Response" } } }
          }
        },
        "x-authz-anonymous": true,
        "security": []
      }
    },
    "/users/{id}": {
      "get": {
        "operationId": "Users_get",
        "tags": ["Users"],
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "number" } }],
        "responses": {
          "200": { "description": "Successful response", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/UserDto" } } } },
          "400": { "description": "Bad request", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/ProblemDetails" } } } },
          "401": { "description": "Unauthorized", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/ProblemDetails" } } } },
          "403": { "description": "Forbidden", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/ProblemDetails" } } } },
          "404": { "description": "Not found", "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/ProblemDetails" } } } }
        },
        "x-authz-permission": ["user:read"],
        "x-authz-resource": { "type": "user" }
      }
    }
  }
}
```

## How the manifest maps to the document

### Paths and operations

| Manifest | OpenAPI |
| --- | --- |
| `RouteEntry.fullPath`, with `routePrefix` and `basePath` | Path key; `:id` becomes `{id}` |
| Controller class name without a trailing `Controller`, and the handler name | `operationId`, such as `Users_get` |
| `@tags` JSDoc tag on the handler | `tags`. Without it the operation is tagged with the controller name without `Controller` |
| `@summary`, `@description`, `@deprecated` JSDoc tags | `summary`, `description`, `deprecated: true` |
| `@Deprecated()` of `@spinajs/http` on the route or its controller | `deprecated: true` |
| Every controller name and every route tag | The top-level `tags`, unique and sorted |

The JSDoc tags are described in [Documenting routes](../http-swagger/02-documenting-routes.md). Two routes with one method and path make the generator throw `duplicate operation`, naming both operation ids.

### Parameters and bodies

Parameters and request bodies follow `ParamEntry.wire`:

| `wire` | OpenAPI |
| --- | --- |
| `value` in query/path/header/cookie | parameter with the derived `schema` |
| `json` in query/path/header/cookie | parameter with `content: { 'application/json': { schema } }` |
| `whole` query (`@QueryField`) | one `form` parameter per DTO property |
| `whole` body (`@Body`, `@BodyField`, `@RawBody`, `@FromXml`) | request body is the DTO schema |
| `field` body | one object request body keyed by the field names |
| `multipart` | `multipart/form-data` object; `multiple` is an array of parts |
| `none` | omitted (injected by the framework) |

A parameter without `wire` throws: the manifest was built by a compiler that does not record it. A `{name}` in the path with no matching parameter gets a required string path parameter.

### Responses and problem+json

| Source | Response |
| --- | --- |
| Return type `void` or `undefined` | `204 No content` |
| `file` routes | `200` with `application/octet-stream`, `type: string`, `format: binary` |
| Any other return type | `200` with the derived schema as `application/json`; with no schema, a `200` that has a description only |
| `@response` JSDoc tags | The status they name. With a type, `application/json`; without one, a problem response |
| A route with request parameters | `400` |
| A route with permissions that is not anonymous | `401` and `403` |
| Status of each entry in the controller's `__http_error_map__` | That status |

Every problem response uses `application/problem+json` and a `$ref` to `ProblemDetails`, the RFC 9457 body that `@spinajs/http` emits ([Error handling](../http/11-error-handling.md)). When the manifest holds a schema with `$id` `spinajs/http/ProblemDetails` it is used, else the `errorSchema` option, else the built-in RFC 9457 shape. Response codes are sorted. The default descriptions are `Bad request` (400), `Unauthorized` (401), `Forbidden` (403), `Not found` (404), `Conflict` (409), `Payload too large` (413), `Validation error` (422) and `Internal server error` (500).

### Access: `@Access`, `@AllowAnonymous` and `@Public`

| On the route or its controller | Operation |
| --- | --- |
| `@AllowAnonymous` | `x-authz-anonymous: true` and `security: []` |
| `@Public('reason')` and no `@Access` | `security: []`, no vendor extension. [`@Public`](../http/13-policies.md#publicreason-a-route-that-is-open-on-purpose) is metadata that says the route is open on purpose |
| `@Access('user:read')` | `x-authz-permission: ['user:read']` and `x-authz-resource: { type: 'user' }` (the part before the first `:`) |
| `@Public` together with `@Access` | The guard still runs: the operation keeps its `x-authz-*` security and `spinajs doctor` warns (`HTTP006`) |
| `@Public` with a `@Policy` and no `@Access` | `security: []`: the generator does not read policies, so the document shows the route as open although the guard runs. Doctor warns (`HTTP006`); describe the guard in the route's JSDoc |

The extensions are the ones `@spinajs/authz-http` writes into the runtime document, so the two stay comparable. A route's own `@Access` replaces the controller's; the controller's applies when the route has none.

## Library use

```ts
import { readManifest } from '@spinajs/manifest';
import { manifestToOpenApi } from '@spinajs/openapi';

const manifest = await readManifest('app.manifest.json');
const doc = manifestToOpenApi(manifest, {
  title: 'Notes API',
  version: '1.2.0',
  servers: [{ url: 'https://api.example.com' }],
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
});
```

| Option | Meaning |
| --- | --- |
| `title`, `version` | Required. `info.title` and `info.version` |
| `servers` | The `servers` array |
| `securitySchemes` | Placed under `components.securitySchemes`. The first one becomes the document-wide `security`; operations marked anonymous or `@Public` opt out with `security: []` |
| `security` | Overrides the document-wide requirement |
| `basePath`, `routePrefix` | As the CLI options above |
| `errorSchema`, `errorSchemaId` | The `$id` of the problem+json schema (default `spinajs/http/ProblemDetails`) and its body when the manifest lacks it |

The CLI passes no security schemes: call the function to add them.

`info.x-spinajs-manifest-hash` holds the hash of the manifest the document came from, so two documents from one manifest are equal and a CI step can diff a committed file ([A CI recipe](../manifest/diff-and-ci.md#a-ci-recipe)).

## Known limits

- A route inherited from an abstract base controller is served but not in the document, because the manifest lists such a base under `controllerBases` ([Known limits in 4.0](../whats-new-4.0.md#known-limits-in-40)).
- The document is as precise as the derived types. [JSDoc constraint tags](../validation/09-dto-constraints-jsdoc.md) on DTO properties carry `format`, `minLength` and the like into the schemas.

## Related

- [Command reference](../cli/08-command-reference.md#generateopenapi)
- [`@spinajs/client`](../client/README.md): a typed client from the same manifest.
- [`@spinajs/asyncapi`](../asyncapi/README.md): the socket and queue counterpart.
