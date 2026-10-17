# Argument hydrators

An argument hydrator turns the raw value of a route argument into the object the action receives. Attach one to a type with `@Hydrator`, and every `@Query()`, `@Param()`, `@Body()`, `@Header()`, `@Cookie()`, `@Form()`, `@FormField()` or `@CsvFile()` argument of that type is built by it. Use it when `new Type(value)` is not enough: parsing a custom format, loading related data, picking a subclass.

## How it works

1. `@Hydrator(HydratorClass, ...options)` stores `{ hydrator, options }` as `custom:arg_hydrator` metadata on the decorated class.
2. When a route argument goes through `RouteArgs.tryHydrateParam()`, `getHydrator()` reads that metadata from the parameter's runtime type, or from the item type of `@Type(Array.ofType(X))`.
3. With a hydrator found, the raw value (after the [input filters](07-argument-input-filters.md)) is validated against the argument's schema first.
4. `DI.resolve(HydratorClass, options)` builds the hydrator; `options` become its constructor arguments.
5. `hydrator.hydrate(input, parameter)` returns the value the action receives. A thrown exception goes to the [error handler](11-error-handling.md).

Primitive types (`string`, `number`, `bigint`, `boolean`) never use a hydrator.

### `DateTimeHydrator`

`HttpBootstrapper.bootstrap()` attaches the **last registered** `DateTimeHydrator` to luxon's `DateTime`, so a `@Query() from: DateTime` argument works with no decorator:

| Input | Result |
| --- | --- |
| a number or numeric string | `DateTime.fromSeconds(value)` (Unix seconds) |
| a string starting with `Date:` | `DateTime.fromHTTP(rest)` |
| any other string | `DateTime.fromISO(value.trim())` |
| anything else | `DateTime.invalid('no iso or unix timestamp')` |

An unparsable string gives an invalid `DateTime` (`isValid === false`), not an error.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Hydrator(hydrator, ...options)` | class | `hydrator`: an `ArgHydrator` class; `options`: constructor arguments for it | Every route argument of this type is built by the hydrator. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ArgHydrator` (abstract) | No token: the class named in `@Hydrator` is resolved with `DI.resolve(Class, options)`; singleton unless decorated `@NewInstance()` | none | `DateTimeHydrator`; `DbModelHydrator` and `RelationResolverHydrator` in `@spinajs/orm-http` | Extend `ArgHydrator`, implement `hydrate()`, name it in `@Hydrator`. To swap the hydrator of a type you do not own, `DI.register(Mine).as(TheirHydrator)`. |
| `DateTimeHydrator` | Key `'DateTimeHydrator'` (its class name), `@Injectable()`, singleton; read by `HttpBootstrapper` with `DI.getRegisteredTypes(DateTimeHydrator)`. Not exported from the package entry. | `DateTimeHydrator` | | `DI.register(Mine).as('DateTimeHydrator')` **before** the bootstrappers run; the last registered type is attached to `DateTime`. |

### `ArgHydrator`: custom implementation

`hydrate(input, parameter)` receives the filtered raw value: a string for query, URL and header values (JSON text for objects), a parsed object for JSON bodies. `parameter` is the `IRouteParameter` with `Name`, `RuntimeType`, `Schema` and `Options`.

```ts sample
import { NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ArgHydrator, BaseController, BasePath, Get, Hydrator, IRouteParameter, Ok, Query } from '@spinajs/http';

/** Parses "<amount> <currency>", eg. "19.99 EUR", into integer minor units. */
@NewInstance()
export class MoneyHydrator extends ArgHydrator {
  constructor(protected AllowedCurrencies: string[]) {
    super();
  }

  public async hydrate(input: unknown, parameter: IRouteParameter): Promise<Money> {
    const match = /^(\d+(?:\.\d{1,2})?)\s+([A-Z]{3})$/.exec(String(input).trim());
    if (!match || !this.AllowedCurrencies.includes(match[2])) {
      throw new InvalidArgument(`${parameter.Name} must look like "19.99 EUR" in ${this.AllowedCurrencies.join(', ')}`, parameter.Name);
    }
    return new Money(Math.round(Number(match[1]) * 100), match[2]);
  }
}

@Hydrator(MoneyHydrator, ['EUR', 'PLN', 'USD'])
export class Money {
  constructor(public readonly minorUnits: number, public readonly currency: string) {}
}

@BasePath('prices')
export class PricesController extends BaseController {
  /** GET /prices/convert?amount=19.99%20EUR */
  @Get('convert')
  public convert(@Query() amount: Money) {
    return new Ok({ cents: amount.minorUnits, currency: amount.currency });
  }
}
```

`MoneyHydrator` is `@NewInstance()` because it takes constructor options: a singleton would keep the options of whichever `@Hydrator` resolved it first.

### `DateTimeHydrator`: custom implementation

Replace the date parsing for every `DateTime` argument, for example to read Unix **milliseconds** from JavaScript clients and to refuse unparsable dates. `DateTimeHydrator` is not exported from the package entry, so you cannot subclass it; extend `ArgHydrator` and register your class under the string key `'DateTimeHydrator'`, which is the key the class registers under.

```ts sample
import { DI } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';
import { ArgHydrator, IRouteParameter } from '@spinajs/http';
import { DateTime } from 'luxon';

export class StrictDateTimeHydrator extends ArgHydrator {
  public async hydrate(input: unknown, parameter: IRouteParameter): Promise<DateTime> {
    const text = String(input).trim();
    const value = /^\d{13}$/.test(text) ? DateTime.fromMillis(Number(text), { zone: 'utc' }) : DateTime.fromISO(text, { zone: 'utc' });

    if (!value.isValid) {
      throw new BadRequest(`${parameter.Name} must be an ISO date or Unix milliseconds`);
    }
    return value;
  }
}

// Before the bootstrappers run: HttpBootstrapper attaches the last type registered under 'DateTimeHydrator'.
DI.register(StrictDateTimeHydrator).as('DateTimeHydrator');
```

## Important behaviour

- With a hydrator, the **raw** value is validated, not the hydrated one. A schema on the type must describe the input format.
- `@Hydrator` keeps the first hydrator found on the class or any parent: a subclass of a hydrated class inherits the parent's hydrator and cannot set its own.
- Hydrators are resolved per argument per request, from the root container. A singleton hydrator is built once.
- `DateTimeHydrator` treats every numeric string as Unix **seconds**: `?from=20260101` is a date in 1970.
- `DateTimeHydrator` returns an invalid `DateTime` for unparsable input; check `isValid` or add a schema.
- Hydrators also run for each CSV row of `@CsvFile()` arguments and for `@Form()` objects.

## Best practices

- Mark a hydrator `@NewInstance()` when it takes options.
- Throw `InvalidArgument` or `BadRequest` for bad input; they answer 400. Any other error answers 500.
- Keep hydrators side-effect free; a policy or middleware may still refuse the request after hydration.

## Patterns and antipatterns

```ts
// Don't: converting inside every action repeats the parsing and the error handling.
@Get('convert')
public convert(@Query() amount: string) {
  const money = parseMoney(amount);
  // ...
}

// Do: hydrate once, by type.
@Get('convert')
public convert(@Query() amount: Money) {
  // amount is already a Money
}
```

## Examples

### Accept a date range as "2026-01-01..2026-01-31"

```ts sample
import { BadRequest } from '@spinajs/exceptions';
import { ArgHydrator, BaseController, BasePath, Get, Hydrator, Ok, Query } from '@spinajs/http';
import { DateTime, Interval } from 'luxon';

export class IntervalHydrator extends ArgHydrator {
  public async hydrate(input: unknown): Promise<ReportPeriod> {
    const [from, to] = String(input).split('..').map((x) => DateTime.fromISO(x));
    const interval = from && to ? Interval.fromDateTimes(from, to) : null;
    if (!interval || !interval.isValid) {
      throw new BadRequest('period must look like 2026-01-01..2026-01-31');
    }
    return new ReportPeriod(interval);
  }
}

@Hydrator(IntervalHydrator)
export class ReportPeriod {
  constructor(public readonly interval: Interval) {}
}

@BasePath('reports')
export class ReportsController extends BaseController {
  /** GET /reports/sales?period=2026-01-01..2026-01-31 */
  @Get('sales')
  public sales(@Query() period: ReportPeriod) {
    return new Ok({ days: period.interval.length('days') });
  }
}
```

## Related

- [Route arguments](04-route-arguments.md#validation-and-conversion): where hydration sits in the argument flow.
- [Argument input filters](07-argument-input-filters.md): run before the hydrator.
- [`@spinajs/orm-http`](../orm-http/README.md): `DbModelHydrator` loads models by primary key.
- [`@spinajs/di`](../di/README.md): lifetimes and resolve options.
