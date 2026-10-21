# OpenAPI documentation

The package documents its routes for `@spinajs/http-swagger` from the same DTOs and schemas the routes validate against. http-swagger documents the `@Body()` DTOs and the `@Param()` schemas itself; `AuthzAdminSchemaProvider` serves the named answer schemas and the batch body, and `describeAuthzAdminDocument(doc, basePath?)` adds what the builder cannot see.

## How it works

1. Importing the package registers `AuthzAdminSchemaProvider` as a `SchemaProvider`. Its `getSchema(typeName)` answers the names in `AUTHZ_ADMIN_SCHEMAS` (answers and errors), `AuthzAdminBatch` over the registered command sources, and `undefined` for any other.
2. http-swagger reads the controller's JSDoc and route table. Every operation is tagged `Authz admin`, with a summary and a description. The `@response` tags name `AuthzAdminResults`, `AuthzAdminPage` and `AuthzAdminError`, which the provider resolves. A `@Body()` DTO becomes the inline `requestBody` schema; a `@Param()` schema the path parameter schema.
3. You call `describeAuthzAdminDocument(doc)` on the built document. It reads the controller's route table, finds each operation by method and path suffix, so a route prefix does not matter (`basePath` is the value of `authz.http.admin.basePath` when the app moved the routes; it defaults to `authz`), and:
   - adds the answer schemas and `AuthzAdminBatch` under `components.schemas`, keeping one that already exists;
   - sets the body of `POST /authz/commands` (`@AdminBatch()`) to `$ref: AuthzAdminBatch`, and the attribute bodies (`@AdminBody()`) to their DTO schema;
   - adds one query parameter per property of the route's query DTO (`@AdminQuery()`), with its schema, `required` and description;
   - copies the description of the `id` and `type` path schemas onto the parameters.
4. It changes the document in place and returns it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzAdminSchemaProvider` | `SchemaProvider` (`@spinajs/validation`), `@Injectable(SchemaProvider)`, registered on import | `AuthzAdminSchemaProvider` | none | Only the swagger builder asks it; the routes validate against the DTOs and `AuthzCommandSchemaRegistry` directly. |
| `SwaggerService` | `SwaggerService`, `@Singleton()` (`@spinajs/http-swagger`) | `SwaggerService` | none | Subclass it and pass `buildSpec()`'s document through `describeAuthzAdminDocument`, as in the example below. |

## Exported schemas and DTOs

| Export | What it holds |
| --- | --- |
| `AUTHZ_ADMIN_SCHEMAS` | The answer and error schemas by name, as the document names them. |
| `AuthzAdminBatch` | Body of `POST /authz/commands` over the built-in command kinds. |
| `AuthzAssignmentGrant`, `AuthzAssignmentPatch` | DTOs of `POST /authz/assignments` and `PATCH /authz/assignments/{id}`; their schemas are `ASSIGNMENT_GRANT_SCHEMA`, `ASSIGNMENT_PATCH_SCHEMA`. |
| `AuthzLinkCreate`, `AuthzLinkPatch` | DTOs of `POST /authz/links` and `PATCH /authz/links/{id}` (`LINK_CREATE_SCHEMA`, `LINK_PATCH_SCHEMA`). |
| `AuthzRuleBody`, `AuthzPolicyBody` | DTOs of `PUT /authz/rules/{id}` and `PUT /authz/policies/{id}` (`RULE_BODY_SCHEMA`, `POLICY_BODY_SCHEMA`). |
| `AuthzAttributesPatch`, `AuthzAttributesBody` | DTOs of `PATCH` and `PUT /authz/scopes/{type}/{id}/attributes`. |
| `AuthzAssignmentsQuery`, `AuthzHoldersQuery`, `AuthzListQuery`, `AuthzOffsetListQuery`, `AuthzWriteOptionsQuery` | Query DTOs of the list routes and of the single-command write routes. |
| `ID_PARAM`, `TYPE_PARAM` | Schemas of the `:id` and `:type` path parameters. |
| `AuthzAdminResults`, `AuthzCommandResult` | The answer of a write and one of its entries. |
| `AuthzAdminPage`, `AuthzAdminAttributes` | The answer of a list, and a scope's attributes. |
| `AuthzAdminError` | The body of a refused request, with every error code and its status. |
| `COMMAND_KINDS`, `commandSchemas` | The 19 built-in command kinds (authz-rbac, authz-abac and the core) and a schema for each. |
| `ruleBody`, `policyBody` | A rule as `rule.put` takes it, a policy as `policy.put` takes it. |
| `JsonSchema` | The type of the schemas (`Record<string, unknown>`). |

## Important behaviour

- **Without `describeAuthzAdminDocument`** the document lists all operations, their answers, the single-command bodies and the path parameters, but not the batch body, the attribute bodies and the query parameters.
- **The schemas validate.** A request that breaks a body, query, path or command schema answers `400` before `AuthzAdmin` runs; see [Input validation](01-admin-routes.md#input-validation).
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

The body of `POST /authz/commands` (`AuthzAdminBatch`) lists one schema per command kind. The schemas come from `AuthzCommandSchemaSource` contributions, one per model: the package registers `RbacCommandSchemas`, `AbacCommandSchemas` and `CoreCommandSchemas`, and `@spinajs/authz-rebac` registers `RebacCommandSchemas`. The route validates each command against the schema of its kind, so a model that declares its own commands in `AuthzCommandMap` must register a source for them, or the route refuses them (`400 invalid_batch` on `commands.<n>.kind`). Close the schemas (`additionalProperties: false`): the validation is not coercing and refuses what the schema does not allow.

```ts
import { Injectable } from '@spinajs/di';
import { AuthzCommandSchemaSource } from '@spinajs/authz-http-admin';

@Injectable(AuthzCommandSchemaSource)
export class QuotaCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return {
      'quota.set': {
        type: 'object',
        additionalProperties: false,
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
| `AuthzCommandSchemaRegistry` | `commands()` merges the sources of the container and its ancestors on each call; `batch()` is `AuthzAdminBatch` over them. `POST /authz/commands` validates against `commands()` on every request. Two sources for one kind, or a schema that names another kind, fail with `AuthzConfigError`. |
| `AuthzAdminSchemaProvider.schemas()` | `AUTHZ_ADMIN_SCHEMAS` with `AuthzAdminBatch` over the registered sources. `getSchema('AuthzAdminBatch')` answers the same. |

`describeAuthzAdminDocument(doc, basePath)` uses the built-in schemas. Pass the registered ones as the third argument to document your own commands too:

```ts
import { DI } from '@spinajs/di';
import { AuthzAdminSchemaProvider, describeAuthzAdminDocument } from '@spinajs/authz-http-admin';

const schemas = (await DI.resolve(AuthzAdminSchemaProvider)).schemas();
describeAuthzAdminDocument(document, 'authz', schemas);
```
