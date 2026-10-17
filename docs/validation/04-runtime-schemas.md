# Runtime schemas

`DataValidator` keeps a registry of schemas by `$id`. Sources fill it at startup; `addSchema()` and `removeSchema()` change it later, for schemas that a plugin installs, a tenant defines or an admin stores in a database. `validateSchema()` checks such a schema before you accept it.

## How it works

### `addSchema(schemaObject, identifier)`

1. `hasSchema(identifier)` checks the registry.
2. Already there: a `warn` log (`Schema <id> already registered, skipping`) and nothing changes. The existing schema stays.
3. Otherwise Ajv registers `schemaObject` under `identifier`. It is compiled on first use, not here.

### `removeSchema(schemaId)`

Removes the schema from Ajv when `hasSchema(schemaId)` is `true`; otherwise does nothing.

### `hasSchema(schemaId)` and `getSchema(schemaId)`

- `hasSchema()` returns `true` when Ajv can resolve the id. Ajv compiles the schema to answer, so a schema that cannot compile (unknown format, broken `$ref`) **throws** here.
- `getSchema()` returns the schema object as it was registered, or `undefined`. It compiles the schema too.

### `validateSchema(schema)`: check a schema before you store it

1. `null`, `undefined` or a non-object: `[false, [{ keyword: 'invalid_argument' }]]`.
2. Ajv checks `schema` against the JSON Schema meta-schema. Failure: `[false, errors]`, each error reduced by [`sanitizeError()`](07-validation-errors.md#sanitizeerror).
3. Ajv compiles `schema`, which finds what the meta-schema accepts but Ajv cannot run: an unknown `format`, an unknown keyword in strict mode, an unresolvable `$ref`. A throw becomes `[false, [{ keyword: 'invalid_schema', message: <Ajv message> }]]`.
4. Otherwise `[true, null]`. The empty schema `{}` is valid: it accepts everything.

A schema **without** `$id` is not registered by `validateSchema()`; call `addSchema()` after it passes. A schema **with** `$id` is registered under that `$id` by the compile step, and a schema whose `$id` is already registered fails with `invalid_schema` (`schema with key or id "<id>" already exists`). See [Important behaviour](#important-behaviour).

## API

| Method | Returns | Meaning |
| --- | --- | --- |
| `addSchema(schemaObject: object, identifier: string)` | `void` | Registers a schema. Skips, with a warning, an id that is already registered. |
| `removeSchema(schemaId: string)` | `void` | Removes a schema; no-op for an unknown id. |
| `hasSchema(schemaId: string)` | `boolean` | Whether the id resolves. Compiles the schema. |
| `getSchema(schemaId: string)` | `Record<string, unknown> \| undefined` | The registered schema object. |
| `validateSchema(schema: object)` | `[boolean, IValidationError[] \| null]` | Meta-schema check plus a compile attempt. Never throws. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Schema registry | Inside `DataValidator` (singleton) | Ajv's own schema store | none | Feed it from a [`SchemaSource`](05-schema-sources.md) at startup, or call `addSchema()` at runtime; override `addSchema()` in a [`DataValidator` subclass](08-customizing-the-validator.md) to observe or veto registrations |

## Important behaviour

- **No replace in place.** `addSchema()` keeps the first schema for an id. To change one, `removeSchema(id)` then `addSchema(newSchema, id)`.
- **`identifier` and `$id` are separate.** `addSchema({ $id: 'http://app/a.json' }, 'http://app/b.json')` makes both ids resolve. Startup sources always register under the schema's `$id`.
- **Ids must be URIs Ajv can serialize.** An id such as `urn:x` throws from `addSchema()` (inside `hasSchema()`).
- **Compilation is lazy and cached.** Errors in a schema show up on the first `hasSchema()`, `getSchema()` or validation, not at `addSchema()`. Call `validateSchema()` first for anything that did not ship with the code.
- **The registry is process-wide.** `DataValidator` is a singleton, so a schema added for one tenant is visible to every caller. Put the tenant in the id (`http://app/tenants/42/order.schema.json`).
- **`validateSchema()` has a side effect for schemas with `$id`.** Its compile step registers the schema under its `$id`, so it is resolvable afterwards even when you never call `addSchema()`. Checking a new version of a registered `$id` fails with `already exists`: call `removeSchema(id)` before `validateSchema()`, or check a copy without `$id` and register it under the id with `addSchema()`.

## Best practices

- Run `validateSchema()` where a schema is written (an admin form, a migration), so a bad one is refused there instead of throwing on every later validation.
- Keep ids stable and versioned (`.../order.v2.schema.json`); a new version is a new id, not a replace.
- For schemas that exist at boot, prefer a [`SchemaSource`](05-schema-sources.md): they are loaded before any request and logged when invalid.

## Patterns and antipatterns

```ts
// Don't: addSchema() keeps the old schema, the new rules are silently ignored
validator.addSchema(updatedSchema, id);

// Do: remove first, then add
validator.removeSchema(id);
validator.addSchema(updatedSchema, id);
```

## Examples

### Store a customer-defined form schema

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { DataValidator, IValidationError } from '@spinajs/validation';

export interface FormDefinition {
  tenantId: number;
  formKey: string;
  schema: Record<string, unknown>;
}

@Injectable()
export class CustomFormSchemas {
  @Autoinject()
  protected Validator!: DataValidator;

  public idOf(tenantId: number, formKey: string) {
    return `http://forms/tenants/${tenantId}/${encodeURIComponent(formKey)}.schema.json`;
  }

  /** Validates, then installs or replaces the schema. Returns the problems when it is refused. */
  public install(form: FormDefinition): IValidationError[] {
    // without $id: validateSchema() would register it, and refuse a second version of the same id
    const { $id: _ignored, ...schema } = form.schema;

    const [isValid, errors] = this.Validator.validateSchema(schema);
    if (!isValid) {
      return errors ?? [];
    }

    const id = this.idOf(form.tenantId, form.formKey);
    this.Validator.removeSchema(id);
    this.Validator.addSchema(schema, id);
    return [];
  }

  public submit(tenantId: number, formKey: string, answers: Record<string, unknown>) {
    // throws ValidationFailed (400 in @spinajs/http) when the answers do not match
    this.Validator.validate(this.idOf(tenantId, formKey), answers);
  }
}
```

## Related

- [Schema sources](05-schema-sources.md): the startup path into the same registry.
- [Value schemas](../configuration-http/03-value-schemas.md): `@spinajs/configuration-http` adds schemas per configuration slug with `addSchema()`.
- [Validation errors](07-validation-errors.md): the error shape `validateSchema()` returns.
