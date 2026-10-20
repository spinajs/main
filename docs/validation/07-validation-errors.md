# Validation errors

`DataValidator.validate()` throws `ValidationFailed` when data breaks a schema; `tryValidate()` and `validateSchema()` return the same errors as an array. Every error is reduced by `sanitizeError()` first, so neither the exception nor the array carries a value from the validated data. A 400 built from them cannot echo a password or a token back.

## How it works

1. Ajv fails and fills its `errors` array. `DataValidator` runs Ajv with `verbose: true`, so each error also holds `data`, `schema` and `parentSchema`.
2. `DataValidator` maps every error through `sanitizeError(error, schema)`. `tryValidate()` and `validateSchema()` return this array.
3. `validate()` throws `new ValidationFailed('validation error', errors, schema)`.
4. The `ValidationFailed` constructor:
   1. stores `schema` as a **non-enumerable** property: available on the server, absent from `JSON.stringify(err)` and `{ ...err }`;
   2. sets `parameter` to the errors, each passed through `sanitizeError(error, schema)` again (a no-op for errors already reduced);
   3. builds `details`: one `{ field, rule, message, params }` per error.
5. `@spinajs/http` answers the exception with `ValidationError` (400); the body is `{ ...err, message }`, so it holds `parameter` and `details` and no schema. `@spinajs/http-socket` answers `invalid_argument` with `details`.

### `sanitizeError()`

`sanitizeError(error, schema?)` returns a new error with only `instancePath`, `schemaPath`, `keyword`, `params`, `message` (when set) and `propertyName` (when set). Then:

| Case | `params` | `message` |
| --- | --- | --- |
| The rule is a `$data` reference (`confirm: { const: { $data: '1/password' } }`), found through `parentSchema`, or through `schema` along a local `schemaPath` | `{ $data: '1/password' }` | `must pass "const" against the value at $data "1/password"` |
| No `parentSchema`, the rule cannot be located, `schema` uses `$data` anywhere, and the keyword can carry a value (`const`, `enum`, `pattern`, `format`, `required`, `minimum`, `maxLength`, `minItems`, `formatMinimum` and the other limits) | `{}` | `must pass "<keyword>" keyword validation` |
| `discriminator` | `tagValue` removed | unchanged |
| anything else | unchanged | unchanged |

The result is remembered in a `WeakSet`; passing it again returns it as is.

### Messages

With `validation.messages: false` (the default) Ajv builds no `message`. `ValidationFailed.details[].message` then falls back to:

| Keyword | Message |
| --- | --- |
| `required` | `Field '<missingProperty>' is required` |
| `type` | `<field> must be of type <type>` |
| `minLength` / `maxLength` | `<field> must be at least <limit> characters long` / `<field> must not exceed <limit> characters` |
| `minimum` / `maximum` | `<field> must be at least <limit>` / `<field> must not exceed <limit>` |
| `pattern` | `<field> does not match the required pattern` |
| `format` | `<field> must be a valid <format>` |
| `enum` | `<field> must be one of: <allowedValues>` |
| `additionalProperties` | `<field> has additional property '<additionalProperty>' which is not allowed` |
| any other | `<field> failed validation rule '<keyword>'` |

`<field>` is the `instancePath`, or `root` for the top level. The `parameter` array keeps Ajv's `message`, which is absent in this mode.

## API

### `ValidationFailed`

`class ValidationFailed extends Exception` (`@spinajs/exceptions`).

| Member | Type | Meaning |
| --- | --- | --- |
| `constructor(message, validationErrors, schema?)` | `(string, IValidationError[], any?)` | Builds the exception; reduces the errors. |
| `parameter` | `IValidationError[]` | The reduced Ajv errors. |
| `details` | `IValidationErrorDetail[]` | `{ field, rule, message, params? }` per error. `field` is the `instancePath`, or `(root)`. |
| `schema` | `any`, non-enumerable | The schema used for validation; server side only. |
| `getSummary()` | `string` | `field: message` pairs joined with `; `. |
| `getFieldErrors(field)` | `IValidationErrorDetail[]` | Details whose `field` equals `field` or starts with `field + '/'`. |
| `getFieldRequirements(field)` | schema node or `null` | Walks `schema.properties` along `field` (`'user/email'` or `'/user/email'`). |
| `getExpectedSchema()` | `any` | Same as `schema`. |
| `toString()` | `string` | Multi-line report: message, each field, rule, message and params, and `Expected schema: <$id>` (or `inline schema`). |

### Types

| Type | Shape |
| --- | --- |
| `IValidationError` | Ajv's `ErrorObject`: `instancePath`, `schemaPath`, `keyword`, `params`, `message?`, `propertyName?` |
| `IValidationErrorDetail` | `{ field: string; rule: string; message: string; params?: Record<string, any> }` |

### Synthetic errors

`DataValidator` returns these without calling Ajv. `validate()` turns the first two into `InvalidArgument`, not `ValidationFailed`.

| `keyword` | `message` | Returned by |
| --- | --- | --- |
| `invalid_argument` | `data is null or undefined` | `tryValidate()` |
| `empty_schema` | `objects schema is not set` | `tryValidate()` |
| `invalid_argument` | `schema is null, undefined or not an object` | `validateSchema()` |
| `invalid_schema` | Ajv's compile error | `validateSchema()` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ValidationFailed` | None: a plain exception class | — | Built by hand in `@spinajs/http` (file uploads, CSV rows), `@spinajs/configuration-http` and its file validators | Throw it from your own checks; subclass it for a domain-specific failure. Its 400 mapping comes from `@spinajs/http` and follows the class name up the prototype chain, so subclasses answer 400 too |
| `sanitizeError()` | Exported function | — | — | Call it on Ajv errors from your own Ajv instance before they leave the server |

### `ValidationFailed`: thrown from your own checks

Throw `ValidationFailed` for rules a schema cannot express (a database lookup, a cross-record rule). Clients get the same 400 shape as for schema failures. Build the errors yourself; put the rule in `keyword` and only non-sensitive data in `params`.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { DataValidator, IValidationError, ValidationFailed } from '@spinajs/validation';

const ROW_SCHEMA = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    team: { type: 'string', minLength: 1 },
  },
  required: ['email', 'team'],
};

/** Validates every row of a member import and reports all failures at once. */
@Injectable()
export class MemberImport {
  @Autoinject()
  protected Validator!: DataValidator;

  public check(rows: Record<string, unknown>[], knownTeams: Set<string>) {
    const problems: IValidationError[] = [];

    rows.forEach((row, index) => {
      const [isValid, errors] = this.Validator.tryValidate(ROW_SCHEMA, row);
      if (!isValid) {
        // re-root each error at its row so the client can point at it
        problems.push(...(errors ?? []).map((e) => ({ ...e, instancePath: `/rows/${index}${e.instancePath}` })));
        return;
      }

      if (!knownTeams.has(row.team as string)) {
        problems.push({
          instancePath: `/rows/${index}/team`,
          schemaPath: '#/properties/team',
          keyword: 'knownTeam',
          params: {},
          message: 'team does not exist',
        });
      }
    });

    if (problems.length > 0) {
      throw new ValidationFailed('member import rejected', problems);
    }
  }
}
```

### `ValidationFailed`: subclass for a domain failure

```ts sample
import { IValidationError, ValidationFailed } from '@spinajs/validation';

/** A price list file that parsed but breaks the business rules. @spinajs/http still answers 400. */
export class PriceListRejected extends ValidationFailed {
  constructor(public readonly fileName: string, errors: IValidationError[]) {
    super(`price list ${fileName} rejected`, errors);
    this.name = 'PriceListRejected';
  }
}

export function rejectNegativePrices(fileName: string, prices: { sku: string; price: number }[]) {
  const errors: IValidationError[] = prices
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.price < 0)
    .map(({ i }) => ({
      instancePath: `/${i}/price`,
      schemaPath: '#/items/properties/price/minimum',
      keyword: 'minimum',
      params: { comparison: '>=', limit: 0 },
    }));

  if (errors.length > 0) {
    throw new PriceListRejected(fileName, errors);
  }
}
```

## Important behaviour

- **No request value in any output.** `details` has no `value`, `parameter` has no `data`, `schema` or `parentSchema`, and `$data` rules report the pointer, not the referenced value. This holds for `JSON.stringify(err)`, `{ ...err }`, `err.toString()`, `details` and `parameter`.
- **`required` reports the parent, not the missing field.** A missing `email` gives `field: '(root)'` with `params.missingProperty: 'email'`. `getFieldErrors('/email')` does **not** find it; read `params.missingProperty`.
- **`getFieldErrors()` matches by prefix.** `getFieldErrors('/user')` returns `/user`, `/user/email` and `/user/address/city`, but not `/username`.
- **`getFieldRequirements()` follows only `properties`.** A field reached through `$ref`, `items`, `allOf` or `oneOf` returns `null`.
- **A hand-built exception redacts `$data` only with help.** `new ValidationFailed(message, errors, schema?)` needs errors from a verbose Ajv run (they carry `parentSchema`) or the `schema` argument. With neither, the params and message of a `$data` rule stay as Ajv built them, request value included.
- **`toString()` names the schema by `$id` only**, never its `title` or `description`.
- **`validate()` also throws `InvalidArgument`** (missing data, unknown schema), which `@spinajs/http` answers with 400 as well but with a different body: no `details`.

## Best practices

- Map client-side messages from `rule` and `params` rather than from `message`; `message` depends on `validation.messages`.
- Re-root errors (`instancePath`) when you validate parts of a larger document, so `field` points at the place in the request the client sent.
- Pass the schema as the third constructor argument when you build a `ValidationFailed` from errors of your own Ajv run with `$data` rules.

## Patterns and antipatterns

```ts
// Don't: copy the offending value into the error; the 400 echoes it to the client and into logs
throw new ValidationFailed('bad token', [
  { instancePath: '/token', schemaPath: '', keyword: 'format', params: { value: token } },
]);

// Do: describe the rule, not the value
throw new ValidationFailed('bad token', [
  { instancePath: '/token', schemaPath: '', keyword: 'format', params: { format: 'jwt' } },
]);
```

## Examples

### Show the first problem per field in a form

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator, IValidationErrorDetail, ValidationFailed } from '@spinajs/validation';

const PROFILE = {
  type: 'object',
  properties: {
    displayName: { type: 'string', minLength: 2 },
    email: { type: 'string', format: 'email' },
  },
  required: ['displayName', 'email'],
};

export async function profileFormErrors(input: Record<string, unknown>): Promise<Record<string, string>> {
  const validator = await DI.resolve(DataValidator);

  try {
    validator.validate(PROFILE, input);
    return {};
  } catch (err) {
    if (!(err instanceof ValidationFailed)) {
      throw err;
    }

    const byField: Record<string, string> = {};
    for (const detail of err.details as IValidationErrorDetail[]) {
      // `required` errors sit on the parent; the field name is in params
      const field = detail.rule === 'required' ? `/${String(detail.params?.missingProperty)}` : detail.field;
      byField[field] ??= detail.message;
    }
    return byField;
  }
}
```

## Related

- [HTTP error mapping](../exceptions/03-http-error-mapping.md): `ValidationFailed` to 400.
- [Error handling](../http/11-error-handling.md): the body `@spinajs/http` sends.
- [Error mapping](../http-socket/05-error-mapping.md): `ValidationFailed` on the socket.
- [File validators](../configuration-http/06-file-validators.md): `ValidationFailed` thrown to reject an upload.
- [Exception classes](../exceptions/01-exception-classes.md): the `Exception` base class.
