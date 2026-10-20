# Named schemas and schema providers

A type name in the documentation (`@returns {InvoiceDto}`, a DTO argument, a model relation) becomes a reusable entry in `components.schemas` and a `$ref` to it. The builder asks every registered `SchemaProvider` for the name; add your own provider to describe types the shipped ones do not know.

## How it works

1. **Tag.** A named type arrives as a bare tag: `{ type: 'object', description: '<Name>' }`, or the same without `type`, with no `format`, `properties`, `items`, `enum`, `oneOf`, `anyOf` or `allOf`. `{Name}` type strings, class-typed arguments without `@Schema`, named return types and ORM relation properties produce it. A node that describes itself is never a tag, even when its description reads like a class name.
2. **Walk.** `OpenApiBuilder.expandNamedSchemas()` walks request bodies (`request` flavour) and response bodies (`response` flavour), descending into `items` and `properties`.
3. **Lookup.** `resolveNamedSchema()` asks the providers:
   - `response` flavour: the first non-`undefined` `getResponseSchema(name)`, else the first non-`undefined` `getSchema(name)`;
   - `request` flavour: the first non-`undefined` `getSchema(name)`.
4. **No answer.** The tag stays in the document as it is.
5. **Name.** `componentNameFor()` resolves both flavours on first sight of a name and compares them as JSON. Equal: one component `<Name>`. Different: the response flavour is `<Name>` and the request flavour is `<Name>Request`, whatever order the routes are visited in.
6. **Register.** The component is reserved before its own schema is expanded, so a cycle (post → user → post) ends in a `$ref`. The provider's JSON schema goes through `convertJsonSchema()`, then nested tags are expanded the same way.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SchemaProvider` (`@spinajs/validation`) | abstract class `SchemaProvider`, singleton per implementation; `@Injectable(SchemaProvider)` registers each one | `DtoSchemaProvider` (`@spinajs/validation`): `@Schema` DTOs by class name | `ModelSchemaProvider` (`@spinajs/orm`): models by class name, with a response flavour; `AuthzAdminSchemaProvider` (`@spinajs/authz-http-admin`); `TeamsHttpSchemaProvider` (`@spinajs/teams-http`) | Add a subclass with `@Injectable(SchemaProvider)`; see below |

How it is resolved: `OpenApiBuilder.SchemaProviders` is `@Autoinject(SchemaProvider)` on an array property, which is `Array.ofType(SchemaProvider)`. Every registered provider is asked, in list order, and the first answer wins. A `@NewInstance()` provider is left out of that list and never asked; see [Multiple implementations](../di/06-multiple-implementations.md).

### Shipped providers

| Provider | Package | Answers | Response flavour |
| --- | --- | --- | --- |
| `DtoSchemaProvider` | `@spinajs/validation` | Classes decorated `@Schema`, by class name | none; both flavours are one component |
| `ModelSchemaProvider` | `@spinajs/orm` | Models, by class name: columns plus relations (one = `$ref`, many = array of `$ref`) | Columns without `required`, without `@Hidden()` columns, with the types the driver returns; see [JSON schema](../orm/11-json-schema.md) |
| `AuthzAdminSchemaProvider` | `@spinajs/authz-http-admin` | Schemas of the authz admin routes | none |
| `TeamsHttpSchemaProvider` | `@spinajs/teams-http` | Response schemas named `Teams*` | none |

### `SchemaProvider`: custom implementation

Write a provider when your routes name types that are neither `@Schema` DTOs nor ORM models: plain interfaces, schemas kept as JSON files, types from another service. Implement `getSchema(typeName)`; override `getResponseSchema(typeName)` only when the API returns a different shape than it accepts. Return `undefined` for names you do not own.

Importing the module registers the class. It must be imported before the first build, which happens on the first `GET /docs/swagger.json`.

```ts sample
import { Injectable } from '@spinajs/di';
import { BaseController, BasePath, Body, Get, Ok, Post } from '@spinajs/http';
import { SchemaProvider } from '@spinajs/validation';

type JsonSchema = Record<string, unknown>;

const PaymentInput: JsonSchema = {
  type: 'object',
  required: ['invoiceId', 'amount'],
  properties: {
    invoiceId: { type: 'integer' },
    amount: { type: 'number', minimum: 0.01 },
  },
};

const Payment: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    invoiceId: { type: 'integer' },
    amount: { type: 'number' },
    settledAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const REQUEST: Readonly<Record<string, JsonSchema>> = { Payment: PaymentInput };
const RESPONSE: Readonly<Record<string, JsonSchema>> = { Payment };

/** Payment schemas for the swagger document. */
@Injectable(SchemaProvider)
export class PaymentSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): JsonSchema | undefined {
    return Object.hasOwn(REQUEST, typeName) ? structuredClone(REQUEST[typeName]) : undefined;
  }

  public getResponseSchema(typeName: string): JsonSchema | undefined {
    return Object.hasOwn(RESPONSE, typeName) ? structuredClone(RESPONSE[typeName]) : undefined;
  }
}

/**
 * Payments of invoices.
 * @tags Payments
 */
@BasePath('payments')
export class PaymentController extends BaseController {
  /**
   * Register a payment
   * @param payment {Payment} Payment to register
   * @returns {Payment} The stored payment
   */
  @Post('/')
  public async create(@Body() payment: object) {
    return new Ok(payment);
  }

  /**
   * List payments
   * @returns {Payment[]} Payments, newest first
   */
  @Get('/')
  public async list() {
    return new Ok([]);
  }
}
```

The document gets two components: `Payment` (the response shape, used by both `200`s) and `PaymentRequest` (the body of `create`).

## Important behaviour

- `convertJsonSchema()` keeps only `type`, `format`, `description`, `enum`, `const` (as a one-value `enum`), `required`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `nullable`, `items`, `properties`, `additionalProperties`, `oneOf`, `anyOf`, `allOf` and `example`. Everything else, such as `default`, `title`, `minItems` or `$ref`, is dropped.
- `type: ['string', 'null']` becomes a `oneOf`, because OpenAPI 3.0 has no type arrays. An `enum` without `type` takes the type of its first value.
- Only `items` and `properties` are walked for tags; a tag inside `oneOf`, `anyOf`, `allOf` or `additionalProperties` stays unresolved.
- Parameters are not walked: a named type on a query or path parameter is not turned into a `$ref`.
- The builder writes into the schema objects it walks. Return a fresh object from `getSchema()` on every call, or one route's expansion rewrites the schema another route gets.
- A schema that cannot be serialized to JSON counts as "flavours differ", which costs one extra component and never merges two contracts.

## Best practices

- Keep provider maps keyed by the exact name your `@returns`, `@response` and `@param` tags use; the lookup is by string.
- Guard lookups with `Object.hasOwn()`. A plain `map[name]` answers `toString` or `constructor` with a function.
- Give response schemas `nullable: true` on columns that can be `null` in practice; generated clients validate against them.

## Patterns and antipatterns

```ts
// Don't: one shared object, rewritten by the builder on every route that uses it
public getSchema(name: string) {
  return SCHEMAS[name];
}

// Do: a fresh copy per call
public getSchema(name: string) {
  return Object.hasOwn(SCHEMAS, name) ? structuredClone(SCHEMAS[name]) : undefined;
}
```

## Related

- [Documenting routes](02-documenting-routes.md#type-strings): how a `{Type}` string becomes a tag.
- [Parameters and request bodies](03-parameters-and-request-bodies.md#schema-of-an-argument): when an argument becomes a tag.
- [JSON schema](../orm/11-json-schema.md): `ModelSchemaProvider` and the model response schema.
- [Multiple implementations](../di/06-multiple-implementations.md): how `Array.ofType` collects providers.
