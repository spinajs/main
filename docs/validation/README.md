# `@spinajs/validation`

JSON-schema validation for SpinaJS, built on [Ajv 8](https://ajv.js.org/) with `ajv-formats`, `ajv-keywords` and `ajv-merge-patch` pre-registered. `DataValidator` validates data against an inline schema, a registered `$id` or a class decorated with `@Schema`, and reports failures as `ValidationFailed` errors that never carry a request value.

It does **not** validate HTTP or socket input by itself: `@spinajs/http` and `@spinajs/http-socket` call `DataValidator` for their route arguments. It does **not** validate configuration files: `@spinajs/configuration` keeps its own Ajv instance.

## Install

```sh
npm install @spinajs/validation
```

Importing the package registers everything it ships: `DataValidator`, `FileSystemSource` as a `SchemaSource`, `DtoSchemaProvider` as a `SchemaProvider`, and the configuration schema of the `validation` key. There is no bootstrapper to run.

## Features

| Feature | What it does |
| --- | --- |
| [Validating data](01-validating-data.md) | `validate()` and `tryValidate()` against a schema object, a schema id or a `@Schema` class |
| [Validator options](02-validator-options.md) | The `validation` config key: the Ajv options, the forced ones and the pre-registered plugins |
| [The `@Schema` decorator](03-schema-decorator.md) | Attaches a schema to a DTO class and registers it by class name |
| [Runtime schemas](04-runtime-schemas.md) | `addSchema()`, `removeSchema()`, `hasSchema()`, `getSchema()` and `validateSchema()` for schemas that arrive at runtime |
| [Schema sources](05-schema-sources.md) | `SchemaSource` and `FileSystemSource`: where the validator loads its schemas from at startup |
| [Schema providers](06-schema-providers.md) | `SchemaProvider` and `DtoSchemaProvider`: type name to JSON schema, for OpenAPI and other tooling |
| [Validation errors](07-validation-errors.md) | `ValidationFailed`, its helpers, and `sanitizeError()`, which keeps request values out of every error |
| [Customizing the validator](08-customizing-the-validator.md) | Replace or subclass `DataValidator`: custom Ajv formats and keywords, extra behaviour around `validate()` |

## Extension points at a glance

| Extension point | DI token and lifetime | How you plug in | Page |
| --- | --- | --- | --- |
| `DataValidator` | Class `DataValidator`, singleton, `AsyncService` | `DI.register(MyValidator).as(DataValidator)` before the first resolve | [Customizing the validator](08-customizing-the-validator.md) |
| `SchemaSource` | Abstract class `SchemaSource`, list (`@Autoinject(SchemaSource)`), each element a singleton | `@Injectable(SchemaSource)` on your class; all sources load | [Schema sources](05-schema-sources.md) |
| `FileSystemSource` | Registered under `SchemaSource`, singleton | Subclass it; `DI.unregister(FileSystemSource)` to drop it | [Schema sources](05-schema-sources.md#filesystemsource-subclass-or-remove) |
| `SchemaProvider` | Abstract class `SchemaProvider`, list (`Array.ofType(SchemaProvider)`), singleton per implementation | `@Injectable(SchemaProvider)` on your class | [Schema providers](06-schema-providers.md) |
| Named schema map | Value map `'__schemas__'`, keyed by type name | `@Schema` on a class, or `DI.register(schema).asMapValue('__schemas__', name)` | [Schema providers](06-schema-providers.md#a-named-schema-without-a-class) |
| `ValidationFailed` | Plain exception class, not in DI | Throw it from your own checks; subclass it | [Validation errors](07-validation-errors.md) |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator, Schema, ValidationFailed } from '@spinajs/validation';

@Schema({
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string', minLength: 2, maxLength: 64 },
  },
  required: ['email'],
})
class SignUpDto {
  public email!: string;
  public displayName?: string;
}

export async function signUp(input: SignUpDto) {
  const validator = await DI.resolve(DataValidator);

  try {
    validator.validate(input);
  } catch (err) {
    if (err instanceof ValidationFailed) {
      // "/email: /email must be a valid email"
      return { ok: false, reason: err.getSummary() };
    }
    throw err;
  }

  return { ok: true };
}
```

## Related packages

- [`@spinajs/http`](../http/04-route-arguments.md#validation-and-conversion): validates every route argument with `DataValidator` and answers `ValidationFailed` with 400.
- [`@spinajs/http-socket`](../http-socket/03-handler-arguments.md): validates socket payloads; `ValidationFailed` becomes `invalid_argument`.
- [`@spinajs/http-swagger`](../http-swagger/04-named-schemas-and-schema-providers.md): asks every `SchemaProvider` for named types.
- [`@spinajs/orm`](../orm/11-json-schema.md): ships `ModelSchemaProvider`, a `SchemaProvider` for models.
- [`@spinajs/configuration-http`](../configuration-http/03-value-schemas.md): validates configuration values against schemas registered here.
- [`@spinajs/configuration`](../configuration/06-schema-validation.md): supplies the `validation` options; validates config with its own Ajv instance.
- [`@spinajs/di`](../di/06-multiple-implementations.md): the `Array.ofType` lists that collect sources and providers.
