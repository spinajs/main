# Watching options

An exposed option with `exposeOptions.watch: true` is polled from the `configuration` table. When its `Value` changed, the new value is written into the live configuration, so `@Config` properties and `Configuration.get()` return it without a restart.

## How it works

1. When `Orm` resolves, `DbConfigSourceBotstrapper` collects the slugs of exposed options with `watch: true` into its watched set. See [Exposing options](02-exposing-options.md).
2. `startWatchTimer()` reads the `__config_watch_interval__` DI value once. A missing or `0` value means 3 minutes (180 000 ms).
3. The timer is armed only when the watched set is not empty. The first late registration with `watch: true` arms an idle timer.
4. Each tick calls `refreshWatched()`: `DbConfig.select().whereIn('Slug', watchedSlugs)`, through `asSystem()` when [authz guarding](06-running-under-authz.md) is on.
5. Rows whose `Exposed` flag is cleared are skipped. For each other row, `isConfigValueEqual(configuration.get(row.Slug), row.Value)` compares the values. `DateTime` values compare by instant, arrays and objects deeply.
6. A changed value is written with `Configuration.set(row.Slug, row.Value)`. `Value` is already typed: the model's `@DbConfigValue` converter ran when the row was hydrated.
7. The next tick is scheduled only after this one settles, so a slow query never overlaps the next. Database errors are logged as `Failed to refresh watched config values from db` and the timer keeps going.
8. `di.dispose` stops the timer.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| DI value `__config_watch_interval__` | `number` (ms) | `180000` | any positive number | Delay between two polls. Read once, when `Orm` resolves. |
| `exposeOptions.watch` on `@Config` | `boolean` | `false` | `true`, `false` | Puts the option's slug in the watched set. |

```ts
// before Orm resolves: poll every 30 seconds
DI.register({ value: 30_000 }).asValue('__config_watch_interval__');
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Poll interval | DI value `'__config_watch_interval__'`, shape `{ value: number }` | not registered (180 000 ms) | any number of milliseconds | `DI.register({ value: ms }).asValue('__config_watch_interval__')` before `Orm` resolves. |
| Poll | `DbConfigSourceBotstrapper.refreshWatched()`, public method of the singleton bootstrapper | runs on the timer | call it yourself | `(await DI.resolve(DbConfigSourceBotstrapper)).refreshWatched()` forces a poll now; see the example below. Subclassing: [Customizing the bootstrapper](09-customizing-the-bootstrapper.md). |
| Change comparison | `isConfigValueEqual(a, b)`, exported function | lodash `isEqualWith` plus `DateTime` instant comparison | none | Not pluggable; call it in your own code to compare config values the same way. |

## Important behaviour

- **Code decides what is watched.** Only slugs declared with `watch: true` in code are polled. Setting the `Watch` column to `1` in the database has no effect.
- **The interval is fixed at startup.** Changing `__config_watch_interval__` after the exposed options were swept into the table does nothing until the next process start.
- **One query per tick.** All watched slugs are read with a single `WHERE Slug IN (...)` query.
- **Hidden rows are not polled into the config.** A watched row with `Exposed` = `0` is skipped until the flag is set again.
- **No schema validation.** A polled value is set as-is; configuration schemas are not re-checked.
- **One configuration is updated.** The poll writes into the `Configuration` of the container that resolved the `Orm`.
- **Changes are eventually visible.** A change shows up after at most one interval plus the query time.

## Best practices

- Watch only options code reads on every use (`@Config` getters, `Configuration.get()` per call). A value copied into a field at startup never sees the update.
- Keep the interval in seconds or minutes. Every tick is a database query.
- After an admin write in your own code, call `refreshWatched()` instead of waiting for the next tick.

## Patterns and antipatterns

```ts
// Don't: the value is copied once, so a watched change never reaches the client
export class PaymentClient {
  @Config('payments.timeoutMs', { defaultValue: 5000, expose: true, exposeOptions: { type: 'number', watch: true } })
  protected TimeoutMs: number;

  private readonly timeout = this.TimeoutMs;
}

// Do: read the decorated property each time it is needed
export class PaymentClient {
  @Config('payments.timeoutMs', { defaultValue: 5000, expose: true, exposeOptions: { type: 'number', watch: true } })
  protected TimeoutMs: number;

  public requestOptions() {
    return { timeout: this.TimeoutMs };
  }
}
```

## Examples

### Turn a feature flag on without a restart

```ts sample
import { DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { DbConfig, DbConfigSourceBotstrapper } from '@spinajs/configuration-db-source';

DI.register({ value: 30_000 }).asValue('__config_watch_interval__');

export class CheckoutFlags {
  @Config('features.checkoutV2', {
    defaultValue: false,
    expose: true,
    exposeOptions: { type: 'boolean', group: 'features', label: 'Checkout v2', watch: true },
  })
  public CheckoutV2: boolean;
}

export async function enableCheckoutV2(): Promise<void> {
  // boolean rows are stored as 'true' / 'false'; '1' would read back as false
  await DbConfig.update({ Value: 'true' }).where('Slug', 'features.checkoutV2');

  // apply now instead of waiting up to 30 s for the next tick
  const bootstrapper = await DI.resolve(DbConfigSourceBotstrapper);
  await bootstrapper.refreshWatched();
}
```

`DI.resolve(DbConfigSourceBotstrapper)` returns the same singleton the bootstrap phase ran, so `refreshWatched()` sees its watched set.

## Related

- [Exposing options](02-exposing-options.md): how a slug enters the watched set.
- [Entry types and the value converter](04-entry-types-and-converter.md): the text form to write for each type.
- [Running under authz](06-running-under-authz.md): the poll runs as `SYSTEM` when the table is guarded.
