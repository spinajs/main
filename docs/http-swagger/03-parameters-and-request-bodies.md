# Parameters and request bodies

The builder turns every route argument into a path, query, header or cookie parameter, a part of the request body, or nothing. The URL template, not the argument list, decides which path parameters an operation has, and an argument that names no placeholder fails the build.

## How it works

`OpenApiBuilder.buildOperation()` runs per route:

1. **Placeholders.** It reads every `{name}` from the full documented path, `@BasePath` and the `basePath` prefix included, in template order and without duplicates.
2. **Arguments.** For each entry of `route.Parameters`:
   - internal arguments are skipped;
   - body arguments are collected for the request body;
   - a path argument is bound to one placeholder by `resolvePathPlaceholder()`, or the build throws;
   - query, header and cookie arguments become parameters, in argument order;
   - a type registered with `registerOpenApiParamType()` is described by its registration ([Custom route-arg types](#custom-route-arg-types));
   - any other type is dropped.
3. **Path parameters.** One required parameter per placeholder, in template order. A bound argument gives it a schema and a description; an unbound placeholder is `{ type: 'string' }`.
4. **Other parameters** follow the path ones.
5. **Body.** A registered body argument, such as `@RequestStream()`, becomes the whole `requestBody`. Otherwise `buildRequestBody()` builds it from the collected body arguments. A route with no body argument gets its `requestBody` from the method's `@body {Type}` tag instead, when it has one.
6. Named types in the body are swapped for `$ref`s to components; see [Named schemas and schema providers](04-named-schemas-and-schema-providers.md).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Query()`, `@QueryField()` | parameter | `schema`, `{ required }` | Query parameter |
| `@Param()`, `@ParamField()`, `@PKey()`, `@Uuid()` | parameter | `schema` | Path parameter, bound to the placeholder of the same name |
| `@Header()`, `@HeadersField()` | parameter | `keyName`, `schema`, `{ required }` | Header parameter |
| `@UserAgent()`, `@Referer()` | parameter | none | `User-Agent` / `Referer` header parameter |
| `@Cookie()` | parameter | `secure` | Cookie parameter |
| `@Body()`, `@BodyField()`, `@Model()` | parameter | none | JSON body, or a property of it |
| `@RawBody()` | parameter | none | JSON body with an unconstrained schema (`{}`) |
| `@FromXml()` | parameter | parser options | `application/xml` body |
| `@RequestStream()` (`@spinajs/http`) | parameter | `maxBytes` | `application/octet-stream` body, `{ type: 'string', format: 'binary' }`, required |
| `@ContentDigest()` (`@spinajs/http`) | parameter | `required`, `algorithms` | Header parameter `content-digest`, `{ type: 'string' }`, required when `{ required: true }` |
| `@Form()`, `@FormField()` | parameter | form options | `multipart/form-data` body fields |
| `@File()`, `@Files()`, `@CsvFile()`, `@JsonFile()` | parameter | upload options, `required` | `multipart/form-data` file field |
| `@AsModel()` (`@spinajs/orm-http`) | parameter | none | JSON body, like `@Body()` |
| `@FromModel()` (`@spinajs/orm-http`) | parameter | `paramType`, `paramField`, `queryField` | The model key: path by default; query or header with `paramType`; no parameter for a body key |
| `@Filter()` (`@spinajs/orm-http`) | parameter | model class or `IColumnFilter[]` | Query parameter named after the argument, with the `{ op, filters }` envelope as JSON content |
| `@Req()`, `@Res()`, `@FromDI()`, `@AcceptType()`, session arguments | parameter | none | Not documented: framework values, not API input |
| `@Ip()`, `@RequestId()` | parameter | none | Not documented |

## Parameters

| Aspect | Rule |
| --- | --- |
| Name | Path: the placeholder. Query and header: `paramField` when the decorator has one, else the `keyName` of `@Header('x-tenant')`, else the argument name. `@UserAgent()` and `@Referer()`: `User-Agent` and `Referer` |
| `required` | `true` for path parameters and for parameters whose decorator options have `{ required: true }`, eg. `@Query()` or `@Header()`; `false` otherwise |
| Description | The argument's `@param` text. For a path parameter, also the `@param` named after the placeholder |
| Object in the query | `content: { 'application/json': { schema } }` instead of `schema` |
| Array in the query | `style: 'form'`, `explode: true` |

### Schema of an argument

The first rule that applies wins:

1. File decorators: `{ type: 'string', format: 'binary' }`; an array of them for `@Files()`, `@File({ asArray: true })` or an array-typed `@File()` argument.
2. A `{Type}` in the argument's `@param` tag; see [type strings](02-documenting-routes.md#type-strings).
3. `@Filter()`: the filter envelope.
4. `@FromModel()`: the key column's type.
5. The schema given to the decorator, eg. `@Query({ type: 'integer', minimum: 1 })`.
6. The primitive schema `@spinajs/http` derives for the argument.
7. `@Schema` metadata on the argument's class, or on the item class of a typed array. A DTO with orm-http `@Relation` fields gets `x-relation: { model, by }` and a note on each of them.
8. The runtime type: `String`, `Number`, `Boolean`, `Array` (of strings), `Object`; another class becomes a named type; no type becomes `string`.

## Path parameters

`resolvePathPlaceholder()` allows two ways for an argument to name a placeholder:

1. `paramField` in the decorator options, which must be a placeholder of the route;
2. the argument's own name, when it equals a placeholder.

Everything else throws `InvalidArgument`, and so does a second argument for a placeholder that is already bound. The message names the controller, method, argument, template and available placeholders, and lists the fixes. `SwaggerService.buildSpec()` collects these errors from every controller and fails the build; see [Swagger service](06-swagger-service.md#how-it-works).

A placeholder without an argument is still documented, so a handler that never reads `:tenant` needs no argument for it.

## Request bodies

| Body arguments | Content type | Schema |
| --- | --- | --- |
| One, not a form or file | `application/json` | That argument's schema; `description` from its `@param`; `required: true` |
| Several, none a form or file | `application/json` | `{ type: 'object', properties }`, one property per argument name |
| Any `@File()`, `@Files()`, `@Form()`, `@FormField()`, `@CsvFile()`, `@JsonFile()` | `multipart/form-data` | `{ type: 'object', properties }`, one property per argument name |
| Any `@FromXml()`, none a form or file | `application/xml` | As for JSON |
| One registered body, eg. `@RequestStream()` | the registration's `contentType`, eg. `application/octet-stream` | the registration's schema; `required` from the registration, default `true` |
| None, and a `@body {Type} description` tag on the method | `application/json` | The schema of `Type` ([type strings](02-documenting-routes.md#type-strings)), named types as `$ref`s; `description` from the tag; `required: true` |
| None, and no `@body` tag | | No `requestBody` |

- A `@Form()` DTO is not nested under its argument name: its properties and its `required` list are lifted to the root, as the runtime reads them.
- `@File({ required: true })` puts the argument name into the body's `required` list.
- `@CsvFile()` and `@JsonFile()` are one binary file, whatever the argument type says about the parsed rows.
- A `requestBody` built from body arguments is always `required: true`; a registered body takes `required` from its registration.
- A registered body is the whole body: it wins over `@body`, and a route that also has any other body argument fails the build.
- A body argument wins over `@body`: the tag is ignored on a route that has one. Use `@body` only for a handler that reads its JSON body from `@Req()`. The `@spinajs/authn-http` routes take `@Body()` DTOs, so their request bodies come from the DTO schemas ([Input validation](../authn-http/24-input-validation.md)).

## Custom route-arg types

A route argument of your own (a `RouteArgs` subclass, see [Custom route arguments](../http/05-custom-route-arguments.md)) has a `Type` the builder does not know, and is dropped from the document. `registerOpenApiParamType(type, describe)` tells the builder how to document it.

1. Call `registerOpenApiParamType('<your IRouteParameter.Type>', describe)` at import, in the module that defines the argument, or in any module loaded before the first build.
2. On every build, for each argument of an unmapped type, the builder calls `describe(param)`. It returns one `OpenApiParamDescription`, an array of them, or `[]` to document nothing.
3. Each description becomes:
   - `in: 'header' | 'query' | 'cookie'`: a parameter named `name`, else the argument name; `required` only when the description says `true`;
   - `in: 'path'`: the path parameter of the placeholder `name` (else the argument name), always required. A name that is no placeholder of the route fails the build, and so does a second argument for one placeholder;
   - `in: 'body'`: the whole `requestBody`, with `content: { [contentType]: { schema } }`, `required` from the description (default `true`), and the argument's `@param` text as its description.

```ts
export type OpenApiParamDescription =
  | { in: 'header' | 'query' | 'path' | 'cookie'; name?: string; required?: boolean; description?: string; schema: object }
  | { in: 'body'; contentType: string; required?: boolean; description?: string; schema: object };

export function registerOpenApiParamType(type: string, describe: (param: IRouteParameter) => OpenApiParamDescription | OpenApiParamDescription[]): void;
```

| Rule | Effect |
| --- | --- |
| A type the builder maps itself (`FromQuery`, `FromBody`, the file and form types, `FromDbModel`, `FilterModelRouteArg`, the internal types) | never consults the registry: its mapping carries runtime contracts |
| A second registration of a type | replaces the first |
| A registered body next to any other body argument (`@Body()`, `@File()`, a second registered body) | the build fails: one request has one body. Move the other values to the path, query or headers, or split the route |
| A registered body and a `@body` JSDoc tag | the registered body wins |
| A `@param` description of the argument | wins over the registration's `description` |
| `describe()` returns a shared `schema` object | it is cloned per build, so editing the built document never changes it |

`@spinajs/http-swagger` registers the two raw-body arguments of `@spinajs/http`:

| Type | Documented as |
| --- | --- |
| `RequestStreamArg` (`@RequestStream()`) | the request body, `application/octet-stream`, `{ type: 'string', format: 'binary' }`, required |
| `ContentDigestArg` (`@ContentDigest()`) | header `content-digest`, `{ type: 'string' }`, required when the decorator has `{ required: true }` |

The registry is a module-level map, not a DI service: nothing to resolve or replace.

### Document a tenant header argument

```ts sample
import { Injectable } from '@spinajs/di';
import { BaseController, BasePath, Get, IRoute, IRouteArgsResult, IRouteCall, IRouteParameter, Ok, Parameter, Request, Route, RouteArgs } from '@spinajs/http';
import { registerOpenApiParamType } from '@spinajs/http-swagger';
import * as express from 'express';

const TENANT = { type: 'string', pattern: '^[a-z0-9-]{2,32}$' };

export function TenantId(header = 'x-tenant-id') {
  return Route(Parameter('TenantIdArg', TENANT, { header }));
}

@Injectable()
export class TenantIdArg extends RouteArgs {
  public get SupportedType(): string {
    return 'TenantIdArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<{ header: string }>, req: Request, _res: express.Response, route?: IRoute): Promise<IRouteArgsResult> {
    const header = param.Options?.header ?? 'x-tenant-id';
    const tenant = await this.tryHydrateParam(req.headers[header], { ...param, Options: { required: true } }, route!);
    return { CallData: callData, Args: tenant };
  }
}

registerOpenApiParamType('TenantIdArg', (param) => ({
  in: 'header',
  name: (param.Options as { header?: string } | null)?.header ?? 'x-tenant-id',
  required: true,
  description: 'Tenant the request acts for',
  schema: TENANT,
}));

/** @tags Invoices */
@BasePath('invoices')
export class InvoicesController extends BaseController {
  /** List the tenant's invoices */
  @Get('/')
  public list(@TenantId() tenant: string) {
    return new Ok({ tenant, items: [] });
  }
}
```

`GET /invoices` is documented with a required `x-tenant-id` header parameter instead of nothing.

## `@spinajs/orm-http` arguments

### `@FromModel()`

The parameter carries the key the model is loaded by, never the model. The key is `queryField`, else the model's `@Primary` column, else the column the driver reported as primary. Its schema follows the column type:

| Column type | Schema |
| --- | --- |
| `tinyint`, `smallint`, `mediumint`, `int`, `integer`, `year` | `integer` |
| `bigint` | `integer`, `int64` |
| `float`, `double`, `real` | `number` |
| `bool`, `boolean`, `bit` | `boolean` |
| `decimal`, `numeric` | `string` (drivers return them as strings) |
| `date` | `string`, `date` |
| `datetime`, `timestamp` | `string`, `date-time` |
| anything else, or no model metadata | `string` |

The description is `<Model>.<key>`. See [Route arguments](../orm-http/02-route-args.md).

### `@Filter()`

Documented as a query parameter with JSON content: `{ op: 'and' | 'or', filters: [...] }`. Each filter item is `{ Column, Value, Operator }`, with `Column` and `Operator` limited to the `@Filterable` columns and their operators. One column gives one item schema; several give a `oneOf`. See [Filtering](../orm-http/03-filtering.md).

## Important behaviour

- The builder reads `@spinajs/orm` and `@spinajs/orm-http` metadata through global symbols (`Symbol.for('MODEL_DESCRIPTOR')`, `Symbol.for('orm-http:relations')`). Neither package is a dependency.
- One unreadable route stops the documentation of its controller at that route, and the whole build fails after every controller was tried.
- The route-arg type registry is global and filled at import: a registration must be loaded before the first build, and stays for the life of the process.

## Best practices

- Name path arguments after their placeholders. Reach for `paramField` only when the argument name has to differ.
- Delete an argument the handler never reads instead of prefixing it with `_`; the placeholder is documented anyway.
- Give query arguments a schema in the decorator (`@Query({ type: 'integer', minimum: 1 })`); it is what the document shows.

## Patterns and antipatterns

```ts
// Don't: `_tenant` matches no placeholder, the whole build fails
@Get(':tenant/invoices/:id')
public async get(@Param() _tenant: string, @Param() id: number) {}

// Do: drop the unused argument, {tenant} is documented from the URL
@Get(':tenant/invoices/:id')
public async get(@Param() id: number) {}
```

```ts
// Don't: the argument name is not a placeholder of the route
@Get(':invoice')
public async get(@FromModel() model: Invoice) {}

// Do: name the placeholder explicitly
@Get(':invoice')
public async get(@FromModel({ paramField: 'invoice' }) model: Invoice) {}
```

## Examples

### Upload scanned receipts with a form

```ts sample
import { BaseController, BasePath, File, Files, Form, Get, Header, IUploadedFile, Ok, Param, Post, Query } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  required: ['amount'],
  properties: {
    amount: { type: 'number', minimum: 0 },
    note: { type: 'string', maxLength: 500 },
  },
})
export class ReceiptForm {
  public amount!: number;
  public note?: string;
}

/**
 * Expense receipts.
 * @tags Expenses
 */
@BasePath('expenses')
export class ExpenseController extends BaseController {
  /**
   * List receipts of an expense report
   * @param report Expense report id
   * @param page Page number, starting at 1
   * @param tenant Tenant the report belongs to
   */
  @Get(':report/receipts')
  public async list(@Param() report: number, @Query({ type: 'integer', minimum: 1 }) page: number, @Header('x-tenant') tenant: string) {
    return new Ok({ report, page, tenant, items: [] });
  }

  /**
   * Upload a receipt
   * @param receipt Receipt amount and note
   * @param scan Scanned receipt
   * @param attachments Extra pages
   */
  @Post(':report/receipts')
  public async upload(@Param() report: number, @Form() receipt: ReceiptForm, @File({ required: true }) scan: IUploadedFile, @Files() attachments: IUploadedFile[]) {
    return new Ok({ report, amount: receipt.amount, scan: scan.Name, pages: attachments.length });
  }
}
```

`list` documents the header as `x-tenant`, the key it is read from; see [Parameters](#parameters). `upload` gets a `multipart/form-data` body with `amount`, `note`, `scan` (binary) and `attachments` (array of binary) at the root, and `required: ['amount', 'scan']`.

## Related

- [Documenting routes](02-documenting-routes.md): `@param` and type strings.
- [Named schemas and schema providers](04-named-schemas-and-schema-providers.md): where DTO and model schemas come from.
- [Route arguments](../orm-http/02-route-args.md), [Filtering](../orm-http/03-filtering.md), [DTO relations](../orm-http/04-dto-relations.md): the `orm-http` side.
