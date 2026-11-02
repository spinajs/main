# Validator options

The `validation` configuration key holds the options of the Ajv instance inside `DataValidator`. They decide whether validation reports every error, strips unknown properties, fills defaults and coerces types.

## How it works

1. `@spinajs/configuration` loads the package defaults from `config/validation.js` of `@spinajs/validation` and merges your config files over them; see [Config files](../configuration/03-config-files.md).
2. Importing `@spinajs/validation` registers its configuration schema (`$id` `spinajs/validation.configuration.schema.json`, module `validation`) with `registerConfigurationSchemaAtImport()`. A value outside the allowed set throws `InvalidConfiguration` at boot.
3. `DataValidator.Options` receives the whole `validation` object through `@Config('validation')`.
4. `DataValidator.resolve()` builds the Ajv options: a `logger` that forwards Ajv messages to the `validation` logger, then every key of `validation` except `strict` (see [Strict schema ids](#strict-schema-ids)), then `$data: true` and `verbose: true`, which always win.
5. It builds two Ajv instances from these options: `Validator`, and `StrictValidator` with `coerceTypes: false`. Every schema is added to both.
6. It registers three Ajv plugins on each instance:
   - `ajv-merge-patch`: the `$merge` and `$patch` keywords;
   - `ajv-formats`: `email`, `date`, `date-time`, `uri`, `uuid`, `ipv4` and the other standard formats;
   - `ajv-keywords`: `transform`, `instanceof`, `range`, `uniqueItemProperties` and the other extra keywords.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `validation.allErrors` | `boolean` | `true` | `true`, `false` | Report every failing rule; `false` stops at the first one. |
| `validation.removeAdditional` | `boolean \| string` | `false` | `true`, `false`, `'all'`, `'failing'` | `true`: delete properties not listed where the schema sets `additionalProperties: false`. `'all'`: delete every unlisted property. `'failing'`: delete the properties that fail `additionalProperties`. |
| `validation.useDefaults` | `boolean \| string` | `true` | `true`, `false`, `'empty'` | Write the schema's `default` into missing properties; `'empty'` also replaces `null` and `''`. |
| `validation.coerceTypes` | `boolean \| string` | `true` | `true`, `false`, `'array'` | Convert values to the schema `type` (`'1'` to `1`); `'array'` also wraps scalars into arrays and back. |
| `validation.messages` | `boolean` | `false` | `true`, `false` | `false`: Ajv builds no `message`; `ValidationFailed` fills one in; see [Validation errors](07-validation-errors.md#messages). |
| `validation.strict.idPrefixes` | `string[]` | `['authn.', 'authz.']` | | Schemas whose `$id` starts with one of these are validated without type coercion. Your list is added to the shipped one (see [Arrays](../configuration/01-configuration-service.md#arrays)). |
| `validation.strict.ajvStrict` | `boolean \| 'log'` | not set | `true`, `false`, `'log'` | Ajv's own strict mode, when `validation.strict` is the object above. |
| `validation.strict` | `boolean \| 'log'` | | `true`, `false`, `'log'` | The older form: Ajv's own strict mode. The id prefixes then keep their default. |
| `validation.<other Ajv option>` | any | not set | any [Ajv option](https://ajv.js.org/options.html) | Passed to the Ajv constructor unchecked: the configuration schema lists only the keys above and does not forbid others. The tests use `discriminator: true`. |
| `validation.$data` | — | `true`, forced | — | Always on: rules may read another field with `{ $data: '1/password' }`. |
| `validation.verbose` | — | `true`, forced | — | Always on: `sanitizeError()` needs `parentSchema` to find `$data` rules. Verbose fields never leave the validator. |

```ts
// config/validation.ts in your app
export default {
  validation: {
    allErrors: true,
    removeAdditional: 'all',
    useDefaults: true,
    coerceTypes: 'array',
    messages: true,
    // any other Ajv option, eg. OpenAPI-style discriminators
    discriminator: true,
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Validation configuration schema | Value `'__configurationSchema__'` in the root container, registered at import | The schema exported as `default` from `schemas/validation.js` | none | Not replaceable from outside; options outside it pass unchecked |
| Ajv instance | `DataValidator.Validator` (protected), built in `resolve()` | Ajv 8 with the three plugins above | none | Subclass `DataValidator` to add formats, keywords or vocabularies; see [Customizing the validator](08-customizing-the-validator.md) |
| Strict Ajv instance | `DataValidator.StrictValidator` (protected), built in `resolve()` with `coerceTypes: false` | Ajv 8 with the three plugins above | none | Used for [strict schema ids](#strict-schema-ids); override `createAjv()` so your formats and keywords reach both instances |
| Default strict prefixes | `DEFAULT_STRICT_ID_PREFIXES`, exported constant | `['authn.', 'authz.']` | | Used when `validation.strict` is not an object with `idPrefixes` |

The package entry also exports the default config object as its `default` export, so bundlers that inline modules still see the defaults.

## Important behaviour

- **Every option changes the data.** `removeAdditional`, `useDefaults` and `coerceTypes` write into the object you validate; see [Validating data](01-validating-data.md#important-behaviour).
- **`removeAdditional: true` strips nothing without `additionalProperties: false`.** Use `'all'` to strip every unlisted property regardless of the schema.
- **The options are read once.** `DataValidator` is a singleton built at its first resolve. A config change after that has no effect until the process restarts.
- **`verbose: false` in your config is ignored.** `DataValidator` forces it on; the errors you receive are still reduced, see [`sanitizeError()`](07-validation-errors.md#sanitizeerror).
- **Ajv runs in strict mode by default.** An unknown keyword (`strict mode: unknown keyword: "sku"`) or format (`unknown format "sku" ignored in schema`) makes compilation throw. Register the keyword or format instead; see [Customizing the validator](08-customizing-the-validator.md). `validation.strict: false` (or `validation.strict.ajvStrict: false` next to `idPrefixes`) silences both, and an unknown format then accepts every value.
- **Configuration has its own Ajv.** `@spinajs/configuration` validates config files with a separate instance; formats or keywords you add to `DataValidator` do not reach it.

### Strict schema ids

`coerceTypes: true` is right for query strings and form fields, where every value arrives as text. For credentials and authorization input it is not: `{ "login": 123 }` would pass as `"123"`. A schema whose `$id` starts with a `validation.strict.idPrefixes` entry is validated on `StrictValidator`, which never coerces; every other option is the same.

```ts
// config/validation.ts in your app
export default {
  validation: {
    strict: {
      // added to the shipped 'authn.' and 'authz.'
      idPrefixes: ['billing.'],
      // Ajv's own strict mode moves here when `strict` is an object
      ajvStrict: true,
    },
  },
};
```

- The id decides, not the caller: `tryValidate('authn.LoginBody', data)`, `tryValidate({ $id: 'authn.LoginBody', ... }, data)` and an instance of a `@Schema({ $id: 'authn.LoginBody', ... })` class are all strict. A schema without `$id` is never strict.
- A `$ref` from a strict schema resolves on the strict instance, so the referenced schema is checked without coercion too.
- Only the `$id` of the schema you validate against counts. A strict-prefixed schema reached by `$ref` from a schema without a strict prefix is validated on the coercing instance, with coercion.
- `DataValidator.isStrict(schemaOrId)` tells which instance a schema uses.
- `removeAdditional` and `useDefaults` still apply on the strict instance.

## Best practices

- Keep `allErrors: true` for request validation: a client fixes every field in one round trip.
- Prefer `additionalProperties: false` in the schema plus `removeAdditional: true` over `'all'`: the schema then states which objects are closed.
- Set `messages: true` when a UI shows Ajv messages directly; keep `false` when you translate messages from `keyword` and `params`.

## Patterns and antipatterns

```ts
// Don't: a whitelist by option only; every schema in the app silently drops unknown fields
export default { validation: { removeAdditional: 'all' } };

// Do: close the objects that must be closed, in the schema
const ProfileUpdate = {
  type: 'object',
  additionalProperties: false,
  properties: { displayName: { type: 'string' }, locale: { type: 'string' } },
};
```

## Examples

### Fill defaults and coerce a query string

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

const LIST_QUERY = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    perPage: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    archived: { type: 'boolean', default: false },
  },
};

export async function readListQuery(raw: Record<string, string>) {
  const validator = await DI.resolve(DataValidator);
  const query: Record<string, unknown> = { ...raw };

  // with the default options: { page: '3' } becomes { page: 3, perPage: 25, archived: false }
  validator.validate(LIST_QUERY, query);

  return query as { page: number; perPage: number; archived: boolean };
}
```

## Related

- [Schema validation](../configuration/06-schema-validation.md): how `@spinajs/configuration` checks the `validation` key.
- [Customizing the validator](08-customizing-the-validator.md): adding formats and keywords to the Ajv instance.
- [Value validation](../configuration-http/02-value-validation.md): how these options change what `@spinajs/configuration-http` stores.
