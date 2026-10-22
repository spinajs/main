# Customizing the validator

`DataValidator` is a replaceable singleton. Register a subclass as `DataValidator` to add Ajv formats, keywords or vocabularies, to observe schema registrations, or to wrap `validate()`; every consumer that resolves `DataValidator` by type then gets your class.

## How it works

1. `DataValidator` is decorated `@Singleton()` and extends `AsyncService`. It is not registered under another token: consumers resolve the class itself (`@Autoinject() Validator: DataValidator`, `DI.resolve(DataValidator)`).
2. `DI.register(MyValidator).as(DataValidator)` adds a registration under the `DataValidator` key. A resolve of `DataValidator` builds the last class registered there, once, and caches it.
3. The container sets the `@Config('validation')`, `@Autoinject(SchemaSource)`, `@Logger('validation')` and `@Autoinject()` properties, then awaits `resolve()`.
4. `super.resolve()` builds two Ajv instances with `createAjv()`: the protected `Validator`, and `StrictValidator` with `coerceTypes: false` for [strict schema ids](02-validator-options.md#strict-schema-ids). Then it loads the [schema sources](05-schema-sources.md) into both.
5. Add formats and keywords by overriding `createAjv()`: both instances get them, before any source schema is loaded.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DataValidator` | Class `DataValidator`; `@Singleton()`; `AsyncService`, so `DI.resolve(DataValidator)` returns a `Promise` | `DataValidator` | None shipped | `DI.register(Subclass).as(DataValidator)` before the first resolve. Anything not resolved by type (`new DataValidator()`) is not affected |

### Members meant for subclasses

| Member | Visibility | Use |
| --- | --- | --- |
| `resolve()` | public | Startup. Call `super.resolve()` first when you override it. |
| `Validator` | protected, `any` | The Ajv 8 instance: `addFormat()`, `addKeyword()`, `addVocabulary()`, `addMetaSchema()`. |
| `StrictValidator` | protected | The second Ajv 8 instance, with `coerceTypes: false`, for [strict schema ids](02-validator-options.md#strict-schema-ids). Add every format and keyword to it too. |
| `createAjv(options)` | protected | Builds one Ajv instance with the three plugins; `resolve()` calls it for both instances. Override it to add a format or keyword to both at once. |
| `isStrict(schemaOrId)` | public | Whether a schema object or registered id is validated on `StrictValidator`. |
| `Options` | public, read-only | The `validation` config object. `@Config` defines it as a getter: assigning to it throws `TypeError`. Change Ajv options in the config. |
| `Sources` | protected | The `SchemaSource` list, before `super.resolve()` loads it. |
| `Log` | protected | The `validation` logger. |
| `Container` | protected | The container that built the validator. |
| `addSchema()`, `removeSchema()`, `hasSchema()`, `getSchema()` | public | Override to observe, veto or namespace registrations. `resolve()` calls `addSchema()` for every source schema. |
| `validate()`, `tryValidate()`, `validateSchema()`, `extractSchema()` | public | Override to wrap validation (metrics, tracing, extra rules). `validate()` and `tryValidate()` share a private implementation and do not call each other: wrap both to see every call. |

### `DataValidator`: custom implementation

Replace the validator when your schemas use formats or keywords Ajv does not ship, for example a tax id or an internal SKU code. Without them, Ajv strict mode throws `unknown format` / `unknown keyword` on the first validation against such a schema.

Register the subclass before anything resolves `DataValidator`: before the first controller, before `@spinajs/configuration-http` routes, before swagger builds. A module imported at application start is the right place.

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

/** Polish NIP: 10 digits with a weighted checksum. */
function isNip(value: string): boolean {
  const digits = value.replace(/[-\s]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    return false;
  }
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  return sum % 11 === Number(digits[9]);
}

export class BillingValidator extends DataValidator {
  // Called for Validator and StrictValidator alike, so strict schema ids can use the format and keyword too.
  protected createAjv(options: object) {
    const ajv = super.createAjv(options);

    // { "type": "string", "format": "nip" }
    ajv.addFormat('nip', { type: 'string', validate: isNip });

    // { "type": "string", "sku": true }
    ajv.addKeyword({
      keyword: 'sku',
      type: 'string',
      schemaType: 'boolean',
      validate: (enabled: boolean, value: string) => !enabled || /^[A-Z]{3}-[0-9]{4}$/.test(value),
    });

    return ajv;
  }
}

// at application start, before anything resolves DataValidator
DI.register(BillingValidator).as(DataValidator);

export async function checkCustomer(customer: { name: string; nip: string; defaultSku: string }) {
  const validator = await DI.resolve(DataValidator); // a BillingValidator
  validator.validate(
    {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        nip: { type: 'string', format: 'nip' },
        defaultSku: { type: 'string', sku: true },
      },
      required: ['name', 'nip'],
    },
    customer,
  );
}
```

### Wrap validation: count failures per schema

`validate()` does not call `tryValidate()`, so override both to observe every validation. Keep the overload signatures so callers type-check, and forward the call with the same number of arguments: the one-argument form reads the schema from the data's `@Schema`.

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator, IValidationError } from '@spinajs/validation';

export class MeteredValidator extends DataValidator {
  public readonly Failures = new Map<string, number>();

  public tryValidate(data: object): [boolean, IValidationError[] | null];
  public tryValidate(schema: object | string, data: object): [boolean, IValidationError[] | null];
  public tryValidate(schemaOrData: object | string, data?: object): [boolean, IValidationError[] | null] {
    const result = arguments.length > 1 ? super.tryValidate(schemaOrData, data!) : super.tryValidate(schemaOrData as object);
    if (!result[0]) this.count(schemaOrData);
    return result;
  }

  public validate(data: object): void;
  public validate(schema: object | string, data: object): void;
  public validate(schemaOrData: object | string, data?: object): void {
    try {
      if (arguments.length > 1) super.validate(schemaOrData, data!);
      else super.validate(schemaOrData as object);
    } catch (err) {
      this.count(schemaOrData);
      throw err;
    }
  }

  private count(schemaOrData: object | string): void {
    const key = typeof schemaOrData === 'string' ? schemaOrData : ((schemaOrData as { $id?: string }).$id ?? 'inline');
    this.Failures.set(key, (this.Failures.get(key) ?? 0) + 1);
  }
}

DI.register(MeteredValidator).as(DataValidator);
```

## Important behaviour

- **Register before the first resolve.** `DataValidator` is cached on its first resolve; a registration after that is ignored by every holder of the cached instance. In tests, `DI.uncache(DataValidator)` forces a rebuild.
- **`DataValidator` resolves asynchronously.** Classes that inject it become async to resolve too; `await` them.
- **Ajv is created inside `resolve()`.** `this.Validator` and `this.StrictValidator` are `undefined` until `super.resolve()` has started; touching them earlier throws.
- **Two instances.** A format or keyword added only to `this.Validator` after `super.resolve()` is missing on `StrictValidator`: a strict-id schema that uses it throws `unknown format` / `unknown keyword`. Add them in `createAjv()`.
- **Options come from config only.** `Options` is a getter over the `validation` key, so a subclass cannot assign it. `$data: true` and `verbose: true` are applied after it and always win.
- **Custom keyword errors keep their `params`.** `sanitizeError()` drops verbose fields from them, but redacts `params` only for `$data` rules and for its fixed list of value-bearing keywords. Do not put request values into the `params` or `message` of your own keyword errors.

## Best practices

- Prefer formats (`addFormat`) for single-value checks and keywords (`addKeyword`) for checks with parameters; formats show up in OpenAPI as `format`.
- Keep the subclass free of per-request state: it is one instance for the whole process.
- Give custom keywords a prefix (`acmeSku`) when schemas are shared with other tools, so they do not clash with future standard or `ajv-keywords` keywords.

## Patterns and antipatterns

```ts
// Don't: a second Ajv instance next to DataValidator; schemas, sources and error sanitizing are not shared
const ajv = new Ajv();
ajv.addFormat('nip', isNip);
ajv.validate(schema, data);

// Do: extend the one validator every package resolves
class BillingValidator extends DataValidator {
  protected createAjv(options: object) {
    const ajv = super.createAjv(options);
    ajv.addFormat('nip', { type: 'string', validate: isNip });
    return ajv;
  }
}
DI.register(BillingValidator).as(DataValidator);
```

## Related

- [Validator options](02-validator-options.md): the options `super.resolve()` passes to Ajv.
- [Schema sources](05-schema-sources.md): what `super.resolve()` loads.
- [Registering services](../di/01-registering-services.md): `register().as()` and override rules.
- [Service lifecycle](../di/10-service-lifecycle.md): `AsyncService.resolve()`.
