# Schema providers

A `SchemaProvider` turns a type name (`InvoiceDto`, `User`) into its JSON schema. Tools that only know names ask every registered provider; today that is `@spinajs/http-swagger`, which builds OpenAPI components from them. `DtoSchemaProvider` ships here and answers for `@Schema` classes; add your own for other kinds of types.

## How it works

1. Each provider is a class registered with `@Injectable(SchemaProvider)`.
2. A consumer injects the whole list: `@Autoinject(SchemaProvider) protected SchemaProviders!: SchemaProvider[]` (`Array.ofType(SchemaProvider)`).
3. For a name, the consumer asks each provider in list order and takes the first answer that is not `undefined`:
   - `getSchema(name)`: the **write** contract, what a client may send;
   - `getResponseSchema?.(name)`: the **read** contract, what the API returns. Optional; a consumer falls back to `getSchema(name)` when every provider returns `undefined`.
4. `DtoSchemaProvider.getSchema(name)`:
   1. reads `name` from the DI value map `'__schemas__'`, then from `getRegisteredSchema(name)`;
   2. nothing found: `undefined`;
   3. a `{ $ref }` entry (from `@Schema('<id>')`): returns `DataValidator.getSchema($ref)`, the registered schema object;
   4. otherwise the schema object itself.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SchemaProvider` | Abstract class `SchemaProvider` (`@Singleton()`, `SyncService`); list resolved with `Array.ofType(SchemaProvider)`; each implementation one singleton | `DtoSchemaProvider` | `ModelSchemaProvider` (`@spinajs/orm`), `AuthzAdminSchemaProvider` (`@spinajs/authz-http-admin`), `TeamsHttpSchemaProvider` (`@spinajs/teams-http`) | Add a subclass with `@Injectable(SchemaProvider)`. Remove one with `DI.unregister(Impl)` before the list is first resolved |
| `DtoSchemaProvider` | Registered under `SchemaProvider` at import; singleton | — | Your subclass | Subclass and override `getSchema()` / `getResponseSchema()`; register it under `SchemaProvider` and `DI.unregister(DtoSchemaProvider)` |
| Named schema map | Value map `'__schemas__'` | Filled by `@Schema` | `IUserMetadataEntry` from `@spinajs/users-http` | `DI.register(schema).asMapValue('__schemas__', name)` |

### Shipped providers

| Provider | Package | Answers | `getResponseSchema` |
| --- | --- | --- | --- |
| `DtoSchemaProvider` | `@spinajs/validation` | `@Schema` classes and `'__schemas__'` entries, by name | not overridden: one shape both ways |
| `ModelSchemaProvider` | `@spinajs/orm` | ORM models by class name: columns plus relations | Columns without `required`, without `@Hidden()` columns, with driver types; see [JSON schema](../orm/11-json-schema.md) |
| `AuthzAdminSchemaProvider` | `@spinajs/authz-http-admin` | Schemas of the authz admin routes | not overridden |
| `TeamsHttpSchemaProvider` | `@spinajs/teams-http` | Response schemas named `Teams*` | not overridden |

### The `SchemaProvider` contract

| Member | Required | Meaning |
| --- | --- | --- |
| `getSchema(typeName: string): Record<string, unknown> \| undefined` | yes (abstract) | The write contract for `typeName`, or `undefined` when this provider does not own the name. |
| `getResponseSchema(typeName: string): Record<string, unknown> \| undefined` | no; the base returns `undefined` | The read contract, when it differs from the write contract. |
| `resolve(): void` | no | `SyncService` hook, run once when the provider is built. Build lookup maps here (`ModelSchemaProvider` does). |

Call `getResponseSchema` as optional (`provider.getResponseSchema?.(name)`): a provider compiled against an older `@spinajs/validation` has no such method.

### `SchemaProvider`: custom implementation

Write a provider when names in your API are neither `@Schema` classes nor ORM models: schemas kept as JSON files under a naming convention, types generated from another service, interfaces described by hand. Return `undefined` for every name you do not own, or you hide the providers after you in the list. Return a fresh object on every call: `@spinajs/http-swagger` writes into the schema objects it walks.

Importing the module registers the class. Do it before the first consumer resolves the list (for swagger, the first `GET /docs/swagger.json`).

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { DataValidator, SchemaProvider } from '@spinajs/validation';

/**
 * Maps type names to schemas the validator already holds, by convention:
 *   Invoice        -> http://billing/invoice.schema.json          (write contract)
 *   Invoice (out)  -> http://billing/invoice.response.schema.json (read contract, when present)
 */
@Injectable(SchemaProvider)
export class BillingSchemaProvider extends SchemaProvider {
  @Autoinject()
  protected Validator!: DataValidator;

  protected idOf(typeName: string, suffix: string) {
    return `http://billing/${typeName.toLowerCase()}${suffix}.schema.json`;
  }

  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return this.copy(this.idOf(typeName, ''));
  }

  public getResponseSchema(typeName: string): Record<string, unknown> | undefined {
    return this.copy(this.idOf(typeName, '.response'));
  }

  protected copy(id: string): Record<string, unknown> | undefined {
    if (!this.Validator.hasSchema(id)) {
      return undefined;
    }
    const { $id: _ignored, ...schema } = this.Validator.getSchema(id) ?? {};
    return structuredClone(schema);
  }
}
```

### `DtoSchemaProvider`: extend it

Subclass `DtoSchemaProvider` to post-process DTO schemas, for example to publish a read contract that hides write-only fields. Register the subclass under `SchemaProvider` and unregister the original, or both answer and the original, earlier in the list, wins.

```ts sample
import { DI } from '@spinajs/di';
import { DtoSchemaProvider, SchemaProvider } from '@spinajs/validation';

const WRITE_ONLY = new Set(['password', 'passwordConfirmation']);

/** DTO schemas without write-only fields on the way out. */
export class PublicDtoSchemaProvider extends DtoSchemaProvider {
  public getResponseSchema(typeName: string): Record<string, unknown> | undefined {
    const schema = this.getSchema(typeName);
    const properties = schema?.properties as Record<string, unknown> | undefined;
    if (!schema || !properties) {
      return undefined;
    }

    // a copy: DtoSchemaProvider returns the object Ajv validates with
    const { required: _required, properties: _properties, ...rest } = structuredClone(schema);
    const visible = Object.fromEntries(Object.entries(properties).filter(([name]) => !WRITE_ONLY.has(name)));
    return { ...rest, properties: structuredClone(visible) };
  }
}

// at startup, before the provider list is first resolved
DI.unregister(DtoSchemaProvider);
DI.register(PublicDtoSchemaProvider).as(SchemaProvider);
```

### A named schema without a class

`DtoSchemaProvider` also answers for any entry in the `'__schemas__'` value map. Register a schema by name when a response is described by an interface or a plain object, with no class to decorate. `@spinajs/users-http` does this for `IUserMetadataEntry`.

```ts sample
import { DI } from '@spinajs/di';

export const AuditEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    action: { type: 'string', enum: ['create', 'update', 'delete'] },
    actorId: { type: 'integer', nullable: true },
    at: { type: 'string', format: 'date-time' },
  },
};

// `@returns {IAuditEntry}` in a controller now resolves to this schema
DI.register(AuditEntrySchema).asMapValue('__schemas__', 'IAuditEntry');
```

The map lives in the container cache: `DI.clearCache()` empties it and only `@Schema` entries survive (through `getRegisteredSchema()`). Register such schemas again after a cache reset.

## Important behaviour

- **First answer wins.** Providers are asked in list order; the list follows registration (import) order. Two providers answering the same name: the earlier one is used.
- **`DtoSchemaProvider` reads `'__schemas__'` before its own map.** An entry registered by hand under a class name overrides that class's `@Schema`.
- **`$ref` entries depend on the validator.** `DtoSchemaProvider` resolves `@Schema('<id>')` through `DataValidator.getSchema()`, which returns `undefined` when no source registered the id; the name is then unknown.
- **`DtoSchemaProvider` returns the shared object.** It is the same object `@Schema` holds and Ajv compiles. A consumer that writes into it changes validation too; copy it when you post-process.
- **`getSchema()` is synchronous.** It cannot be `async`; load what you need in `resolve()` or through an injected service.
- **The list resolves as a `Promise`.** `DtoSchemaProvider` injects `DataValidator`, an `AsyncService`, so `DI.resolve(Array.ofType(SchemaProvider))` returns a `Promise`; `await` it. `@Autoinject` handles this for you.
- **No provider validates data.** Providers describe types; validation always goes through `DataValidator`.

## Best practices

- Guard map lookups with `Object.hasOwn()`; `map[name]` answers `toString` or `constructor` with a function.
- Override `getResponseSchema()` only when the shapes really differ; `@spinajs/http-swagger` then emits two components (`<Name>` and `<Name>Request`).
- Keep provider names identical to the names in `@returns`, `@response` and `@param` tags: the lookup is by exact string.

## Patterns and antipatterns

```ts
// Don't: answer every name; providers after this one are never asked
public getSchema(typeName: string) {
  return SCHEMAS[typeName] ?? { type: 'object' };
}

// Do: answer only your own names
public getSchema(typeName: string) {
  return Object.hasOwn(SCHEMAS, typeName) ? structuredClone(SCHEMAS[typeName]) : undefined;
}
```

## Related

- [Named schemas and schema providers](../http-swagger/04-named-schemas-and-schema-providers.md): how `@spinajs/http-swagger` uses the providers.
- [JSON schema](../orm/11-json-schema.md): `ModelSchemaProvider`.
- [The `@Schema` decorator](03-schema-decorator.md): what fills `'__schemas__'`.
- [Values and value maps](../di/09-values-and-value-maps.md): `asMapValue` and the container cache.
