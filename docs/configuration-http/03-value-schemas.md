# Value schemas

A value schema adds rules to one configuration entry beyond its `Type` and `Meta`: a pattern, a length, the shape of a `json` object. Register a schema in `@spinajs/validation` whose `$id` equals the entry slug (the path passed to `@Config(path, { expose: true })`); every write of that entry is then validated against it.

## How it works

1. At boot, `DataValidator.resolve()` loads every `SchemaSource` (by default `FileSystemSource`, which reads `system.dirs.schemas`) and adds each schema under its `$id`.
2. On each write, `validateEntryValue()` asks `DataValidator.hasSchema(entry.Slug)`. The question is asked per request, so a schema added at runtime applies to the next write.
3. When it exists, the value schema becomes `{ allOf: [<Type + Meta schema>, { $ref: '<slug>' }] }` ([Value validation](02-value-validation.md)).
4. ajv compiles the slug schema lazily, on first use, in strict mode. A schema that fails to compile raises `SchemaCompileError`: `PATCH` answers `500`, `ConfigFileUploads` throws a plain `Error`. The ajv detail is logged, not returned.
5. Both `Value` and `Default` are checked. For a `file` entry, the generated stored name is checked on `accept` and the name passed to `commit`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.schemas` | `string[]` | set by the app and packages | directories | `FileSystemSource` loads every `*.json` file and every `*.js` / `*.cjs` / `*.mjs` file (its default export) in them. |

A schema file:

```json
{
  "$id": "reports.financial.template",
  "type": "string",
  "pattern": "\\.xlsx$"
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Schema source | `SchemaSource`, resolved as a list by `DataValidator` at boot | `FileSystemSource` (`system.dirs.schemas`) | Your own `@Injectable(SchemaSource)` class | Add a source; all sources load, none replaces another. |
| Runtime schema | `DataValidator.addSchema(schema, slug)` / `removeSchema(slug)` | — | — | Add at any time; `addSchema` skips an id that exists, so call `removeSchema` first to replace one. |

### Schema source: custom implementation

Write a `SchemaSource` when the rules live in code: they are typed, reviewed with the option they guard, and need no file on disk. Register it before `DataValidator` resolves; a decorated class imported at startup is enough.

```ts sample
import { Injectable } from '@spinajs/di';
import { ISchema, SchemaSource } from '@spinajs/validation';

/** Rules for the exposed options of the invoicing module, keyed by their config path. */
@Injectable(SchemaSource)
export class InvoicingConfigSchemas extends SchemaSource {
  public async Load(): Promise<ISchema[]> {
    return [
      {
        schema: { $id: 'invoicing.numberPattern', type: 'string', minLength: 3, maxLength: 40, pattern: '\\{n\\}' },
      },
      {
        schema: {
          $id: 'invoicing.reminders',
          type: 'object',
          properties: {
            afterDays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 90 }, maxItems: 5 },
            copyToAccountant: { type: 'boolean', default: false },
          },
          required: ['afterDays'],
          additionalProperties: false,
        },
      },
    ];
  }
}
```

### Runtime schema: add or replace one

A module that installs its options at runtime (a plugin, a tenant feature) registers the rule through `DataValidator`:

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

export async function limitExportRows(maxRows: number): Promise<void> {
  const validator = await DI.resolve(DataValidator);
  const schema = { $id: 'exports.maxRows', type: 'integer', minimum: 100, maximum: maxRows };

  // addSchema ignores an id that is already registered
  validator.removeSchema(schema.$id);
  validator.addSchema(schema, schema.$id);
}
```

## Important behaviour

- The schema describes the JSON value as sent to the API: an ISO string for `date`, an array for `manyOf`, an object for `json`.
- ajv runs in strict mode. A custom keyword (an `x-*` annotation too) or format must be registered with ajv, or every write of that entry fails with `500` and a logged error. The meta-schema check at boot does **not** catch this.
- `validation.useDefaults` writes the schema's `default` values into object and array values before they are stored: the default is fixed at write time.
- `validation.removeAdditional` strips unknown properties instead of rejecting them.
- A `file` entry's slug schema sees the generated name `<base>-<yyyyMMdd-HHmmss>.<ext>`, not the uploaded name. Anchor patterns on the extension.

## Best practices

- Name the schema file after the slug (`reports.financial.template.json`) so it is found from the option.
- Keep `additionalProperties: false` on `json` entries; operators then get a 400 for a typo instead of a silently ignored key.
- Test a new schema with one `PATCH` in development: compile errors only appear on first use.

## Patterns and antipatterns

```ts
// Don't: an annotation keyword the strict ajv does not know. Every PATCH of the entry answers 500.
const schema = { $id: 'app.theme', type: 'string', 'x-widget': 'select' };

// Do: keep UI hints out of the value schema; put the allowed values in exposeOptions.meta.oneOf.
const fixed = { $id: 'app.theme', type: 'string', minLength: 1 };
```

## Examples

### Accept only PDF files for a contract template

```json
{
  "$id": "contracts.template",
  "type": "string",
  "pattern": "\\.pdf$"
}
```

An upload of `offer.xlsx` to `contracts.template` is rejected by `ConfigFileUploads.accept` with `ConfigFileRejected`, and nothing is stored.

### Restrict a `json` entry

```json
{
  "$id": "app.limits",
  "type": "object",
  "properties": {
    "perPage": { "type": "integer", "minimum": 1, "maximum": 100 },
    "export": { "type": "boolean" }
  },
  "required": ["perPage"],
  "additionalProperties": false
}
```

`PATCH /configuration/app.limits` with `{ "Value": { "perPage": 0 } }` answers `400` with a message naming `Value/perPage`.

## Related

- [Value validation](02-value-validation.md): how the slug schema is combined with `Type` and `Meta`.
- [File uploads](05-file-uploads.md): the stored name is checked against the slug schema.
- [`@spinajs/validation`](../validation/README.md): `DataValidator`, `SchemaSource`, ajv options.
