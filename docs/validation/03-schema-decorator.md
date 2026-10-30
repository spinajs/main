# The `@Schema` decorator

`@Schema` attaches a JSON schema to a class, usually a DTO. `DataValidator` then validates instances without naming a schema, `@spinajs/http` validates route arguments of that type, and `DtoSchemaProvider` resolves the schema by class name for OpenAPI.

## How it works

1. `@Schema(schema)` runs once, when the module that declares the class is imported.
2. It stores `schema` as metadata under `SCHEMA_SYMBOL` on `target.prototype`.
3. It builds the registered form: the object itself, or `{ $ref: schema }` when `schema` is a string id.
4. It stores the registered form twice, keyed by `target.name`:
   - in a module-level map read by `getRegisteredSchema(name)`, which survives `DI.clearCache()`;
   - in the DI value map `'__schemas__'` with `DI.register(registered).asMapValue('__schemas__', target.name)`.
5. Consumers read it back:
   - `DataValidator.tryValidate(instance)` and `validate(instance)` read the metadata through the prototype chain;
   - `DataValidator.extractSchema(classOrInstance)` reads it from a constructor or an instance;
   - `DtoSchemaProvider.getSchema(name)` reads `'__schemas__'` first, then `getRegisteredSchema(name)`, and resolves a `$ref` through `DataValidator.getSchema()`;
   - `@spinajs/http-swagger` and `@spinajs/orm-http` read `SCHEMA_SYMBOL` directly.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Schema(schema: object \| string)` | class | A JSON schema object, or the `$id` of a registered schema | Stores the schema as class metadata and registers it under the class name |

## Exports

| Export | Type | Meaning |
| --- | --- | --- |
| `Schema(schema)` | class decorator factory | See above. |
| `SCHEMA_SYMBOL` | `symbol` | The metadata key. Read it with `Reflect.getMetadata(SCHEMA_SYMBOL, ctor.prototype)`. It is not the ORM's `SCHEMA_SYMBOL` (`Symbol.for('ORM_SCHEMA_SYMBOL')`). |
| `getRegisteredSchema(typeName)` | `(string) => object \| undefined` | The registered form for a class name: the schema object, or `{ $ref }` for the string form. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Named schema map | Value map `'__schemas__'` (`Map<string, object>`) in the root container cache | Filled by `@Schema` | Entries registered by hand, eg. `IUserMetadataEntry` in `@spinajs/users-http` | `DI.register(schema).asMapValue('__schemas__', name)`; see [Schema providers](06-schema-providers.md#a-named-schema-without-a-class) |

`@Schema` is a plain function, not a service. To derive schemas another way (from ORM columns, from a remote registry), add a [`SchemaProvider`](06-schema-providers.md) instead of changing the decorator.

## Important behaviour

- **The string form is a reference, resolved late.** `@Schema('http://app/product.schema.json')` stores the id. Validation and `DtoSchemaProvider` resolve it from the schemas `DataValidator` holds at that moment; an id nobody registered gives `empty_schema` on validation.
- **Class names are global keys.** Two `@Schema` classes with the same name overwrite each other in `'__schemas__'` and in `getRegisteredSchema()`; the one imported last wins. Validation of instances is not affected: it reads the metadata of each class.
- **Subclasses inherit the schema.** The metadata is on the prototype, so an undecorated subclass validates against its parent's schema. Decorate the subclass to give it its own; it is then also registered under its own name.
- **`DI.clearCache()` empties `'__schemas__'`, not the decorator's own map.** `DtoSchemaProvider` falls back to `getRegisteredSchema()`, so DTOs keep resolving after a cache reset (tests do this).
- **The schema object is shared.** The same object is the metadata, the map entry and what Ajv compiles. Do not mutate it after declaration.

## Best practices

- Give each DTO a distinct class name; OpenAPI component names and the `'__schemas__'` keys come from it.
- Use the string form when the same schema is also loaded from a file or used by non-class code; use the object form for schemas that belong to one DTO.
- Declare property types on the class (`public email!: string;`) so the code that reads the instance agrees with the schema.

## Patterns and antipatterns

```ts
// Don't: rely on the class constructor carrying the schema
validator.validate(CreateInvoiceDto); // empty_schema: InvalidArgument

// Do: validate an instance, or pass the extracted schema
validator.validate(Object.assign(new CreateInvoiceDto(), body));
validator.validate(validator.extractSchema(CreateInvoiceDto), body);
```

## Examples

### A DTO with an inline schema

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator, Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  properties: {
    customerId: { type: 'integer', minimum: 1 },
    lines: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          sku: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{4}$' },
          quantity: { type: 'integer', minimum: 1 },
        },
        required: ['sku', 'quantity'],
      },
    },
  },
  required: ['customerId', 'lines'],
})
export class CreateInvoiceDto {
  public customerId!: number;
  public lines!: { sku: string; quantity: number }[];

  constructor(data: Partial<CreateInvoiceDto>) {
    Object.assign(this, data);
  }
}

export async function checkInvoice(body: Partial<CreateInvoiceDto>) {
  const validator = await DI.resolve(DataValidator);
  const [isValid, errors] = validator.tryValidate(new CreateInvoiceDto(body));
  return isValid ? [] : errors ?? [];
}
```

### A DTO that references a shared schema

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator, Schema, getRegisteredSchema } from '@spinajs/validation';

// The schema is loaded from system.dirs.schemas or added with addSchema() under this $id.
@Schema('http://app/address.schema.json')
export class AddressDto {
  public street!: string;
  public city!: string;
  public postalCode!: string;
}

export async function describeAddress() {
  const validator = await DI.resolve(DataValidator);

  // { $ref: 'http://app/address.schema.json' }
  const registered = getRegisteredSchema('AddressDto');

  // the schema object itself, or undefined when no source registered the id
  const schema = validator.getSchema('http://app/address.schema.json');

  return { registered, schema };
}
```

## Standard Schema

`@Schema` also accepts a [Standard Schema](https://standardschema.dev) v1 object, such as `z.object(...)` from zod. `@spinajs/validation` does not depend on any schema library: it detects the `~standard` member and calls `~standard.validate(data)`.

```ts
import { z } from 'zod';

@Schema(z.object({ name: z.string() }))
export class CreateUserDto {
  public name: string;
}
```

- Issues become Ajv-shaped errors (`keyword: 'standardSchema'`, a JSON pointer `instancePath`, the issue message), so `ValidationFailed` and the problem+json body keep their shape.
- Validation is synchronous: a validator that returns a promise makes `validate` and `tryValidate` throw `InvalidOperation`. A validator that throws yields a generic error without its message.
- The class is not added to the `'__schemas__'` map, so `getRegisteredSchema` returns `undefined` for it.
- For the manifest and OpenAPI, the compiler never runs the schema. For zod 4 export a literal JSON Schema next to the class: `export const CreateUserDtoJsonSchema = { ... }`. Otherwise it reports `SCH004` and publishes the schema derived from the class. See the [compiler diagnostics](../compiler/README.md).

## Related

- [Schema providers](06-schema-providers.md): `DtoSchemaProvider` reads what this decorator registers.
- [Route arguments](../http/04-route-arguments.md#validation-and-conversion): a `@Schema` class as a route argument type.
- [DTO relations](../orm-http/04-dto-relations.md): `@spinajs/orm-http` reads `SCHEMA_SYMBOL` from DTOs.
- [Values and value maps](../di/09-values-and-value-maps.md): how `asMapValue` stores `'__schemas__'`.
