# Validating data

`DataValidator` checks data against a JSON schema. `validate()` throws on failure; `tryValidate()` returns `[isValid, errors]` and throws only on a programming error (see [Important behaviour](#important-behaviour)). Use it in services, jobs and imports; HTTP and socket route arguments already go through it.

## How it works

1. `DI.resolve(DataValidator)` builds the singleton. `DataValidator.resolve()` creates the Ajv instance from the [`validation` options](02-validator-options.md), adds the plugins and loads every [schema source](05-schema-sources.md). The resolve returns a `Promise`.
2. You call `tryValidate(schema, data)` or `tryValidate(data)`. The schema is resolved by `resolveSchema()`:
   - one argument: the `@Schema` metadata found on `data` (an instance of a decorated class);
   - a string: the schema registered under that `$id`;
   - an object: used as the schema itself.
3. No data (`null` / `undefined` as the only argument): the result is `[false, [{ keyword: 'invalid_argument', message: 'data is null or undefined' }]]`.
4. No schema found: the result is `[false, [{ keyword: 'empty_schema', message: 'objects schema is not set' }]]`.
5. Ajv validates. On failure each Ajv error goes through [`sanitizeError()`](07-validation-errors.md#sanitizeerror) and the result is `[false, errors]`; on success `[true, null]`.
6. `validate()` calls `tryValidate()` and turns a failure into an exception by the keyword of the first error:

| First error keyword | `validate()` throws |
| --- | --- |
| `invalid_argument` | `InvalidArgument('data is null or undefined')` (`@spinajs/exceptions`) |
| `empty_schema` | `InvalidArgument('objects schema is not set')` |
| any Ajv keyword | [`ValidationFailed`](07-validation-errors.md)`('validation error', errors, schema)` |

## API

| Method | Returns | Meaning |
| --- | --- | --- |
| `validate(data)` | `void` | Validates an instance of a `@Schema` class against its schema. Throws on failure. |
| `validate(schema, data)` | `void` | Validates `data` against a schema object or a registered `$id`. Throws on failure. |
| `tryValidate(data)` | `[boolean, IValidationError[] \| null]` | Like `validate(data)`, without throwing on invalid data. |
| `tryValidate(schema, data)` | `[boolean, IValidationError[] \| null]` | Like `validate(schema, data)`, without throwing on invalid data. |
| `extractSchema(target)` | `ISchemaObject` or `undefined` | The `@Schema` metadata of an instance or a class constructor. |

The schema registry methods (`addSchema`, `removeSchema`, `hasSchema`, `getSchema`, `validateSchema`) are on [Runtime schemas](04-runtime-schemas.md).

## Configuration

`DataValidator` reads the `validation` key; see [Validator options](02-validator-options.md). Schema files come from `system.dirs.schemas`; see [Schema sources](05-schema-sources.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DataValidator` | Class `DataValidator`, `@Singleton()`, `AsyncService`; resolved by type (`@Autoinject()` or `DI.resolve(DataValidator)`) | `DataValidator` | None shipped | Subclass and `DI.register(MySubclass).as(DataValidator)` before the first resolve; see [Customizing the validator](08-customizing-the-validator.md) |

Consumers in the monorepo resolve it by type: `BaseController._validator` and `RouteArgs.Validator` in `@spinajs/http`, the argument handler of `@spinajs/http-socket`, `ConfigurationController` and `ConfigFileUploads` in `@spinajs/configuration-http`, `DtoSchemaProvider` here. A replacement registered as `DataValidator` reaches all of them.

## Important behaviour

- **Validation changes the data.** With the default options Ajv coerces types (`'5'` becomes `5`) and fills `default` values in the object you pass. With `removeAdditional` on, it also deletes properties. Pass a copy when the caller must keep the original.
- **A broken schema throws, also from `tryValidate()`.** Ajv compiles the schema on first use. An unknown keyword or format (Ajv strict mode) or an unresolvable `$ref` throws an `Error` from both methods. Check schemas that arrive at runtime with [`validateSchema()`](04-runtime-schemas.md#validateschemaschema-check-a-schema-before-you-store-it) first.
- **An inline schema with `$id` registers itself.** Ajv adds the first schema object it compiles under its `$id`. A different object reusing that `$id` (eg. built fresh on every call) is validated as a copy without the `$id`, so it does not throw, but the copy is cached per object: build such a schema once and reuse it, or register it with `addSchema()` and validate by id.
- **Strict on missing input.** An unknown schema id or an undecorated object is a failure (`empty_schema`), never a silent pass.
- **A class works as the schema in the two-argument form.** `tryValidate(SignUpDto, data)` reads the `@Schema` metadata from the class prototype. The one-argument form validates the value you pass, so give it an instance. `validator.extractSchema(SignUpDto)` returns the schema directly.
- **Absent data is reported as absent.** `tryValidate(schema, undefined)` and `tryValidate('<schema id>', null)` return an `invalid_argument` error; `validate()` throws `InvalidArgument` `data is null or undefined`.
- **`extractSchema()` on a plain object returns `undefined`.** It is safe for class constructors, instances, and objects without `@Schema` metadata.
- **Data must be an object type in TypeScript.** The signature takes `object`; a string or number validates at runtime, but needs a cast.
- **Schema ids must be URIs Ajv can serialize.** `http://app/invoice.schema.json` works; an id such as `urn:x` (a URN without a namespace) throws inside Ajv on `addSchema()`.

## Best practices

- Resolve `DataValidator` once (`@Autoinject()` in a service) instead of `await DI.resolve()` on every call; it is a singleton.
- Use `tryValidate()` when a failure is an expected branch (an import row, a webhook payload) and `validate()` when it should abort the request: `@spinajs/http` answers the thrown `ValidationFailed` with 400.
- Reference shared schemas by `$id` (`validate('http://app/address.schema.json', data)`) rather than copying the object into several places; `$ref` between registered schemas works the same way.

## Patterns and antipatterns

```ts
// Don't: the class constructor carries no metadata, the result is always empty_schema
const [ok] = validator.tryValidate(SignUpDto);

// Do: validate an instance, or read the class schema first
const [ok] = validator.tryValidate(Object.assign(new SignUpDto(), body));
const [ok2] = validator.tryValidate(validator.extractSchema(SignUpDto), body);
```

```ts
// Don't: validate the caller's object when the original must survive (coercion and defaults write into it)
validator.validate('http://app/order.schema.json', request.body);

// Do: validate a copy
const order = structuredClone(request.body);
validator.validate('http://app/order.schema.json', order);
```

## Examples

### Validate an incoming webhook before queueing it

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

const PAYMENT_WEBHOOK = {
  type: 'object',
  properties: {
    eventId: { type: 'string', minLength: 1 },
    type: { enum: ['payment.settled', 'payment.refunded'] },
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  },
  required: ['eventId', 'type', 'amount', 'currency'],
};

@Injectable()
export class PaymentWebhookInbox {
  @Autoinject()
  protected Validator!: DataValidator;

  public accept(body: unknown): { accepted: boolean; problems: string[] } {
    if (body === null || typeof body !== 'object') {
      return { accepted: false, problems: ['body must be a JSON object'] };
    }

    // a copy: coerceTypes and useDefaults write into the validated object
    const event = structuredClone(body);
    const [isValid, errors] = this.Validator.tryValidate(PAYMENT_WEBHOOK, event);

    if (!isValid) {
      return { accepted: false, problems: (errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.keyword}`) };
    }

    return { accepted: true, problems: [] };
  }
}
```

### Validate against a schema shipped as a file

```ts sample
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

// schemas/invoice.schema.json in a directory listed in system.dirs.schemas, with
// "$id": "http://billing/invoice.schema.json"
export async function assertInvoice(invoice: { number: string; total: number }) {
  const validator = await DI.resolve(DataValidator);
  validator.validate('http://billing/invoice.schema.json', invoice);
}
```

## Related

- [Validation errors](07-validation-errors.md): what `ValidationFailed` and the error array contain.
- [The `@Schema` decorator](03-schema-decorator.md): attaching a schema to a class.
- [Route arguments](../http/04-route-arguments.md#validation-and-conversion): how `@spinajs/http` validates arguments with this service.
- [Error mapping](../http-socket/05-error-mapping.md): `ValidationFailed` on the socket.
