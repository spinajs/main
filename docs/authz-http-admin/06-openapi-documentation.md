# OpenAPI documentation

The package documents its routes for `@spinajs/http-swagger` in two parts. `AuthzAdminSchemaProvider` serves the named answer schemas, and `describeAuthzAdminDocument(doc, basePath?)` adds the request bodies and query parameters that http-swagger cannot see.

The routes read their body and query string from `@Req()` on purpose, so no http-layer step can refuse what `AuthzAdmin` would answer. The price is that the swagger builder sees no body or query argument; you add them with `describeAuthzAdminDocument`.

## How it works

1. Importing the package registers `AuthzAdminSchemaProvider` as a `SchemaProvider`. Its `getSchema(typeName)` answers the names in `AUTHZ_ADMIN_SCHEMAS` and `undefined` for any other.
2. http-swagger reads the controller's JSDoc. Every operation is tagged `Authz admin`, with a summary and a description. The `@response` tags name `AuthzAdminResults`, `AuthzAdminPage` and `AuthzAdminError`, which the provider resolves.
3. You call `describeAuthzAdminDocument(doc)` on the built document. For each entry of `AUTHZ_ADMIN_ROUTES` it finds the operation by method and path suffix, so a route prefix does not matter (`basePath` is the value of `authz.http.admin.basePath` when the app moved the routes; it defaults to `authz`), and:
   - adds every schema of `AUTHZ_ADMIN_SCHEMAS` under `components.schemas`, keeping one that already exists;
   - sets the JSON `requestBody` to the route's body schema;
   - adds the missing query parameters with their encodings;
   - describes the path parameters `id` and `type`.
4. It changes the document in place and returns it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzAdminSchemaProvider` | `SchemaProvider` (`@spinajs/validation`), `@Injectable(SchemaProvider)`, registered on import | `AuthzAdminSchemaProvider` | none | Only the swagger builder asks it; request validation does not read it. |
| `SwaggerService` | `SwaggerService`, `@Singleton()` (`@spinajs/http-swagger`) | `SwaggerService` | none | Subclass it and pass `buildSpec()`'s document through `describeAuthzAdminDocument`, as in the example below. |

## Exported schemas

| Export | What it holds |
| --- | --- |
| `AUTHZ_ADMIN_SCHEMAS` | Every schema below by name, as the document names them. |
| `AUTHZ_ADMIN_ROUTES` | `{ method, path, body?, query? }` for each of the 18 routes. |
| `AuthzAdminBatch` | Body of `POST /authz/commands`. |
| `AuthzAssignmentGrant`, `AuthzAssignmentPatch` | Bodies of `POST /authz/assignments` and `PATCH /authz/assignments/{id}`. |
| `AuthzLinkCreate`, `AuthzLinkPatch` | Bodies of `POST /authz/links` and `PATCH /authz/links/{id}`. |
| `AuthzRuleBody`, `AuthzPolicyBody` | Bodies of `PUT /authz/rules/{id}` and `PUT /authz/policies/{id}`. |
| `AuthzAttributesPatch`, `AuthzAttributesBody` | Bodies of `PATCH` and `PUT /authz/scopes/{type}/{id}/attributes`. |
| `AuthzAdminResults`, `AuthzCommandResult` | The answer of a write and one of its entries. |
| `AuthzAdminPage`, `AuthzAdminAttributes` | The answer of a list, and a scope's attributes. |
| `AuthzAdminError` | The body of a refused request, with every error code and its status. |
| `COMMAND_KINDS`, `commandSchemas` | The 19 built-in command kinds (authz-rbac, authz-abac and the core) and a schema for each. |
| `ruleBody`, `policyBody` | A rule as `rule.put` takes it, a policy as `policy.put` takes it. |
| `JsonSchema` | The type of all of the above (`Record<string, unknown>`). |

## Important behaviour

- **Without `describeAuthzAdminDocument`** the document lists all 18 operations and their answers, but no request body and no query parameter.
- **The schemas document, they do not validate.** A request that breaks a schema still reaches `AuthzAdmin`, which answers it.
- **The JSDoc is read from the compiled controller** (`lib/*/controllers/AuthzAdminController.js`), as http-swagger does for every controller.

## Examples

### Complete the document of an app

```ts sample
import { DI } from '@spinajs/di';
import { IOpenApiDocument, SwaggerService } from '@spinajs/http-swagger';
import { describeAuthzAdminDocument } from '@spinajs/authz-http-admin';

export class AppSwaggerService extends SwaggerService {
  public async buildSpec(): Promise<IOpenApiDocument> {
    // getSpec() serves the object the base class cached, so change it in place.
    return describeAuthzAdminDocument(await super.buildSpec());
  }
}

// Before the HTTP server starts.
DI.register(AppSwaggerService).as(SwaggerService);
```

## Related

- [Swagger service](../http-swagger/06-swagger-service.md): `buildSpec()` and how to replace the service.
- [Named schemas and schema providers](../http-swagger/04-named-schemas-and-schema-providers.md): how `{AuthzAdminResults}` resolves to a schema.
- [Admin routes](01-admin-routes.md): the routes these schemas describe.

## Commands of other models

The body of `POST /authz/commands` (`AuthzAdminBatch`) lists one schema per command kind. The schemas come from `AuthzCommandSchemaSource` contributions, one per model: the package registers `RbacCommandSchemas`, `AbacCommandSchemas` and `CoreCommandSchemas`. A model that declares its own commands in `AuthzCommandMap` registers a source for them:

```ts
import { Injectable } from '@spinajs/di';
import { AuthzCommandSchemaSource } from '@spinajs/authz-http-admin';

@Injectable(AuthzCommandSchemaSource)
export class QuotaCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return {
      'quota.set': {
        type: 'object',
        required: ['kind', 'scope', 'limit'],
        properties: { kind: { type: 'string', enum: ['quota.set'] }, scope: { type: 'object' }, limit: { type: 'integer' } },
      },
    };
  }
}
```

| Name | What it does |
| --- | --- |
| `AuthzCommandSchemaSource` | Abstract: `schemas()` returns command kind -> JSON schema. Each schema's `properties.kind.enum` must be `[kind]`. |
| `AuthzCommandSchemaRegistry` | `commands()` merges the sources of the container and its ancestors on each call; `batch()` is `AuthzAdminBatch` over them. Two sources for one kind, or a schema that names another kind, fail with `AuthzConfigError`. |
| `AuthzAdminSchemaProvider.schemas()` | `AUTHZ_ADMIN_SCHEMAS` with `AuthzAdminBatch` over the registered sources. `getSchema('AuthzAdminBatch')` answers the same. |

`describeAuthzAdminDocument(doc, basePath)` uses the built-in schemas. Pass the registered ones as the third argument to document your own commands too:

```ts
import { DI } from '@spinajs/di';
import { AuthzAdminSchemaProvider, describeAuthzAdminDocument } from '@spinajs/authz-http-admin';

const schemas = (await DI.resolve(AuthzAdminSchemaProvider)).schemas();
describeAuthzAdminDocument(document, 'authz', schemas);
```
