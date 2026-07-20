# `@spinajs/validation`

JSON-schema validation for the SpinaJS framework, built on [AJV](https://ajv.js.org/) with
`ajv-formats`, `ajv-keywords` and `ajv-merge-patch` pre-registered. Schemas can be attached to
classes with the `@Schema` decorator or loaded automatically from the filesystem.

## Install

```bash
npm install @spinajs/validation
```

The package is registered in the SpinaJS DI container. Resolve the validator wherever you need it:

```typescript
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

const validator = await DI.resolve(DataValidator);
```

## Configuration

Options under the `validation` configuration key are passed straight to the AJV constructor. Defaults:

```typescript
const config = {
  validation: {
    // report every error, not only the first one that occurred
    allErrors: true,

    // remove properties that are not defined in schema
    // (only strips when the schema declares `additionalProperties: false`)
    removeAdditional: false,

    // fill in `default` values from the schema
    useDefaults: true,

    // coerce data to the types declared in the schema (e.g. "1" -> 1)
    coerceTypes: true,

    // disable AJV message generation (leave error messages to tools such as ajv-i18n)
    messages: false,
  },
};
```

Schema directories are read from `system.dirs.schemas` (see [filesystem schema sources](#filesystem-schema-sources)).

## `DataValidator` API

| method | description |
| --- | --- |
| `validate(data)` / `validate(schema, data)` | Validates `data`. Throws on failure. |
| `tryValidate(data)` / `tryValidate(schema, data)` | Validates `data`. Returns `[isValid, errors]` and never throws. |
| `addSchema(schemaObject, id)` | Registers a schema. Warns (and skips) if `id` is already registered. |
| `removeSchema(id)` | Removes a registered schema. No-op if it is not registered. |
| `hasSchema(id)` | Returns `true` if a schema with `id` is registered. |
| `getSchema(id)` | Returns the registered schema object (unwrapped) or `undefined`. |

`schema` may be:

- a schema **object** (used inline),
- a **string** id / `$ref` of a previously registered schema,
- a **class instance or constructor** decorated with `@Schema` (the schema is read from decorator metadata).

```typescript
// throw-on-failure
try {
  validator.validate('http://myapp/product.schema.json', { productId: 1 });
} catch (err) {
  // err is a ValidationFailed exception
}

// non-throwing
const [isValid, errors] = validator.tryValidate('http://myapp/product.schema.json', { productId: 1 });
if (!isValid) {
  console.log(errors);
}
```

### Strict behavior

The validator is intentionally **strict**: anything it cannot verify is treated as a failure rather than a
silent pass.

- `data` is `null` / `undefined` → `tryValidate` returns an error with keyword `invalid_argument`;
  `validate` throws `InvalidArgument('data is null or undefined')`.
- The schema cannot be resolved (unknown id, or a plain object with no `@Schema` decorator) →
  `tryValidate` returns an error with keyword `empty_schema`; `validate` throws
  `InvalidArgument('objects schema is not set')`.

```typescript
const [ok, errors] = validator.tryValidate('unknown-schema-id', data);
// ok === false, errors[0].keyword === 'empty_schema'
```

## The `@Schema` decorator

Attach a schema to a class so its instances can be validated without naming a schema explicitly. Two forms
are supported.

Inline schema object:

```typescript
import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  properties: {
    firstName: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['firstName'],
})
class Person {
  firstName: string;
  age: number;
}

const p = new Person();
p.firstName = 'John';

validator.validate(p); // schema is read from the decorator
```

Reference to a registered schema by id (`$ref` form):

```typescript
@Schema('http://myapp/product.schema.json')
class ProductDto {
  productId: number;
}
```

Both forms also register the class under the `'__schemas__'` DI map keyed by class name, so the schema can be
resolved by name (used by `SchemaProvider`, e.g. for OpenAPI generation).

## Filesystem schema sources

On resolve, `DataValidator` loads every schema found in the directories listed in `system.dirs.schemas`.
Supported file types:

- `.json` — parsed as JSON.
- `.js`, `.cjs`, `.mjs` — imported dynamically; the schema must be the module's **default export**.

Each schema **must** declare a `$id`; it is registered under that id. Files are handled defensively:

- a JS/ESM module with **no default export** is skipped with a warning,
- a **malformed** `.json` file is skipped with an error log,
- a schema missing `$id` or failing AJV's schema validation is skipped with an error log.

A bad file never aborts loading of the other schemas.

```javascript
// schemas/product.schema.mjs
export default {
  $id: 'http://myapp/product.schema.json',
  type: 'object',
  properties: { productId: { type: 'integer' } },
  required: ['productId'],
};
```

## Extending

### Custom schema sources (`SchemaSource`)

Register additional sources (database, remote, etc.) by implementing `SchemaSource`. Every registered
source is loaded when the validator resolves.

```typescript
import { Injectable } from '@spinajs/di';
import { SchemaSource, ISchema } from '@spinajs/validation';

@Injectable(SchemaSource)
export class MySchemaSource extends SchemaSource {
  public async Load(): Promise<ISchema[]> {
    return [{ schema: { $id: 'http://myapp/remote.schema.json', type: 'object' }, file: 'remote' }];
  }
}
```

### Custom schema providers (`SchemaProvider`)

`SchemaProvider` maps a type name to its JSON schema (used e.g. by `@spinajs/http-swagger` for OpenAPI). The
built-in `DtoSchemaProvider` resolves `@Schema`-decorated DTO classes. Add your own:

```typescript
import { Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

@Injectable(SchemaProvider)
export class MySchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    // return a schema, or undefined if this provider doesn't know the type
    return undefined;
  }
}
```

## `ValidationFailed` error details

`validate` throws `ValidationFailed` on failure. Beyond the raw AJV `parameter` errors it exposes helpers for
inspecting what went wrong:

```typescript
try {
  validator.validate(schema, data);
} catch (err) {
  if (err instanceof ValidationFailed) {
    err.details;            // [{ field, rule, message, value?, params? }, ...]
    err.data;               // the data that failed
    err.schema;             // the schema used for validation

    err.getSummary();       // "field: message; field: message"
    err.getFieldErrors('/user');            // errors for a field (exact + nested prefix match)
    err.getFieldRequirements('user/email'); // schema node for a field, or null if unknown
    err.toString();         // full multi-line report incl. schema $id
  }
}
```

`details[].field` is the failing JSON pointer (`/user/email`, or `(root)` for the top level), `rule` is the
AJV keyword (`required`, `type`, `format`, ...), and `message` falls back to a readable string when AJV
message generation is disabled (`messages: false`).
