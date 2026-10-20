# Value validation

Every `Value` and `Default` written through this package is validated against a JSON schema built from the entry: a base schema for its `Type`, the bounds and allowed values of its `Meta`, and the schema registered under its slug. The same check guards `PATCH /configuration/:slug` and the stored name of [`ConfigFileUploads`](05-file-uploads.md).

It validates only. Converting the value into its stored string form is the job of `DbConfigValueConverter` in `@spinajs/configuration-db-source`.

## How it works

1. The caller (the controller, `ConfigFileUploads`, or your own code) calls `validateEntryValue(validator, entry, field, value)`.
2. `DataValidator.hasSchema(entry.Slug)` checks for a schema registered under the slug. A throw here becomes `SchemaCompileError`.
3. `valueSchema(entry.Type, entry.Meta, schemaRef)` builds the schema:
   - copies `VALUE_SCHEMAS[Type]`;
   - applies `Meta` to the leaf: the `items` schema for array types, the schema itself otherwise;
   - wraps it as `{ allOf: [typeSchema, { $ref: slug }] }` when a slug schema exists.
4. `DataValidator.tryValidate()` validates `{ [field]: value }` against `{ type: 'object', properties: { [field]: schema }, required: [field] }`. Wrapping keeps a bare `null` or scalar from being read as a schema.
5. `formatValidationErrors(field, errors)` joins the errors into one message. `validateEntryValue()` returns it, or `null` when the value is valid.

### Base schema per `Type`: `VALUE_SCHEMAS`

| `Type` | Schema | Accepted JSON value |
| --- | --- | --- |
| `string`, `file`, `oneOf` | `{ type: 'string' }` | `"text"` |
| `manyOf` | `{ type: 'array', uniqueItems: true, items: { type: 'string' } }` | `["a", "c"]` |
| `number` | `{ type: 'integer' }` | `50` |
| `float`, `range` | `{ type: 'number' }` | `0.75` |
| `boolean` | `anyOf` boolean, or string `'0' \| '1' \| 'true' \| 'false'` | `true`, `"1"` |
| `date` | `{ type: 'string', format: 'date' }` | `"2021-06-15"` |
| `time` | `{ type: 'string', format: 'time' }` | `"08:30:00"` |
| `datetime` | `{ type: 'string', format: 'date-time' }` | `"2021-06-15T08:30:00Z"` |
| `date-range`, `time-range`, `datetime-range` | array of the matching format | `["2021-01-01", "2021-06-01"]` |
| `json` | `{}` | anything |

### `Meta` keys applied to the leaf

| `Meta` key | Schema keyword | Applies to |
| --- | --- | --- |
| `oneOf` | `enum` | the string |
| `manyOf` | `enum` | each item |
| `min` | `minimum` | the number, or each item |
| `max` | `maximum` | the number, or each item |
| `minDate` | `formatMinimum` | the date / time string, or each item |
| `maxDate` | `formatMaximum` | the date / time string, or each item |

`Meta.file` is not part of the value schema; it drives [file uploads](05-file-uploads.md).

### Error messages

`formatValidationErrors()` builds one entry per error, `<field><path> <message>`, removes duplicates and joins them with `; `:

- `field` is `Value` or `Default`; `path` is the part of the ajv `instancePath` below the field, such as `/perPage`.
- `message` is the ajv message. With the `@spinajs/validation` default `validation.messages: false`, ajv sends none and the entry reads `Value/perPage is invalid`.
- No errors at all give `invalid value for <field>`.

## Configuration

This feature reads the `@spinajs/validation` options of `DataValidator`. They change what is stored:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `validation.useDefaults` | `boolean` | `true` | `true`, `false` | Writes schema defaults into object and array values before they are stored, so they are fixed at write time. |
| `validation.coerceTypes` | `boolean` | `true` | `true`, `false` | Coerces scalars during the check (`"50"` passes an `integer` schema). |
| `validation.removeAdditional` | `boolean` | `false` | `true`, `false` | Strips unknown properties of object values instead of rejecting them. |
| `validation.allErrors` | `boolean` | `true` | `true`, `false` | Reports every error, joined into one message. |
| `validation.messages` | `boolean` | `false` | `true`, `false` | `true` puts ajv's text into the 400 message. |

```ts
export default {
  validation: { messages: true, removeAdditional: false },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DataValidator` | `DataValidator`, singleton, resolved with `@Autoinject()` by `ConfigurationController` and `ConfigFileUploads` | `DataValidator` of `@spinajs/validation` | None shipped | Add a slug schema ([Value schemas](03-value-schemas.md)) rather than replacing the validator. |
| `validateEntryValue()` | Exported function | — | — | Call it from your own routes with the injected `DataValidator`. |
| `valueSchema()` / `VALUE_SCHEMAS` | Exported function and constant | — | — | Read them to render a form or to document an entry; `valueSchema()` returns a fresh copy. |
| `SchemaCompileError` | Exported class, `Error` with `Slug` | — | — | Catch it, log `message`, and answer with a sanitized error. |

### Custom routes over the validation helpers

A project that needs another endpoint, for example a "check before save" button in an admin panel, reuses `validateEntryValue()` and gets the same answer `PATCH` would give. Load the entry the way the controller does: as `SYSTEM`, then a row check for the caller.

```ts sample
import { BaseController, BasePath, Body, Ok, Param, Post, ServerError } from '@spinajs/http';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { SYSTEM, authz } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { Autoinject } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { DbConfig } from '@spinajs/configuration-db-source';
import { SchemaCompileError, UpdateConfigDto, validateEntryValue } from '@spinajs/configuration-http';

/** POST /configuration-check/:slug answers whether a PATCH with the same body would pass validation. */
@BasePath('configuration-check')
export class ConfigurationCheckController extends BaseController {
  @Autoinject()
  protected Validator!: DataValidator;

  @Logger('configuration-check')
  protected Log!: Log;

  @Post(':slug')
  @Access('configuration:update')
  public async check(@CurrentPrincipal() caller: Principal, @Param() slug: string, @Body() data: UpdateConfigDto) {
    const service = authz();
    const entry = await service.runAs(SYSTEM, 'configuration-check:load', async () => DbConfig.where('Slug', slug).first());
    if (!entry || !(await service.can(caller, 'configuration:update', { type: 'configuration', id: String(entry.Id) }, entry))) {
      throw new ResourceNotFound(`configuration entry ${slug} not found`);
    }

    try {
      const message =
        validateEntryValue(this.Validator, entry, 'Value', data.Value) ??
        (data.Default !== undefined ? validateEntryValue(this.Validator, entry, 'Default', data.Default) : null);
      return new Ok({ valid: message === null, message });
    } catch (err) {
      if (err instanceof SchemaCompileError) {
        this.Log.error({ error: err }, 'Configuration schema compilation failed');
        return new ServerError({ error: { message: `configuration schema '${err.Slug}' is invalid` } });
      }
      throw err;
    }
  }
}
```

## Important behaviour

- The slug schema always applies to the whole value; `Meta` constraints apply to the leaf.
- The schema describes the JSON value as sent to the API, not the typed runtime value: a `date` is a string, never a luxon `DateTime`.
- `SchemaCompileError` never reaches the client with the ajv detail. The controller logs it and answers `500`; `ConfigFileUploads` logs it and throws a plain `Error`.
- An entry without a slug schema is validated by `Type` and `Meta` only.
- `structuredClone` copies the base schema on every call, so changing the returned schema never affects `VALUE_SCHEMAS`.

## Best practices

- Put bounds that never change in `exposeOptions.meta` (`min`, `max`, `oneOf`); put structural rules for `json` values in a slug schema.
- Turn on `validation.messages` when operators read the 400 message; the default only says which field is invalid.
- Compare a `manyOf` value with `Meta.manyOf`, not with a hand-written `enum` in a slug schema: the type schema already adds it per item.

## Patterns and antipatterns

```ts
// Don't: validate against the bare type schema; it skips the slug schema the admin registered.
const [ok] = validator.tryValidate(valueSchema(entry.Type, entry.Meta), { Value: value });

// Do: validateEntryValue resolves the slug schema and wraps the value.
const message = validateEntryValue(validator, entry, 'Value', value);
```

## Examples

### Show the rules of an entry in a settings form

```ts sample
import { valueSchema } from '@spinajs/configuration-http';

// Built for a `manyOf` entry: the allowed values land on the items.
const schema = valueSchema('manyOf', { manyOf: ['pdf', 'xlsx', 'csv'] });
// { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['pdf', 'xlsx', 'csv'] } }

const withSlugSchema = valueSchema('number', { min: 1, max: 100 }, 'app.maxUsers');
// { allOf: [{ type: 'integer', minimum: 1, maximum: 100 }, { $ref: 'app.maxUsers' }] }

export { schema, withSlugSchema };
```

## Related

- [Value schemas](03-value-schemas.md): register the schema `validateEntryValue()` picks up.
- [Configuration API](01-configuration-api.md): where the check runs on `PATCH`.
- [`@spinajs/validation`](../validation/README.md): `DataValidator`, its options and schema sources.
