# Watching options

A row of the `configuration` table whose `Watch` column is set is polled. When its `Value` changed, the new value is written into the live configuration, so `@Config` properties and `Configuration.get()` return it without a restart.

The column decides, not the code. `exposeOptions.watch` only seeds `Watch` when the row is inserted; after that an admin turns watching on or off for a row by writing the column, and the next poll follows it.

## How it works

1. When the `configuration` table is ready, `DbConfigSourceBotstrapper` sweeps the exposed options into it and starts the watch timer. The timer starts whether or not any option declares `watch: true`. See [Exposing options](02-exposing-options.md).
2. `startWatchTimer()` reads the `__config_watch_interval__` DI value once. A missing or `0` value means 3 minutes (180 000 ms).
3. Each tick calls `refreshWatched()`: `DbConfig.select().asRaw()`, through `asSystem()` when [authz guarding](06-running-under-authz.md) is on. Rows whose `Watch` or `Exposed` flag is not set are dropped in memory, so the filter does not depend on how a driver stores booleans. The rows are read raw, so a row that is not watched is never converted.
4. For each kept row, `DbConfigValueConverter.fromDB()` turns the stored `Value` text into a value of the row's `Type`, and `isConfigValueEqual(configuration.get(row.Slug), value)` compares it with the live one. `DateTime` values compare by instant, arrays and objects deeply.
5. A changed value is written with `Configuration.set(row.Slug, value)`. A value that cannot be read as its `Type`, or that the configuration refuses, is skipped and the poll goes on with the next row; that row is not tried again until its `Value` changes.
6. The next tick is scheduled only after this one settles, so a slow query never overlaps the next. Database errors are logged as `Failed to refresh watched config values from db` and the timer keeps going.
7. `di.dispose` stops the timer.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| DI value `__config_watch_interval__` | `number` (ms) | `180000` | any positive number | Delay between two polls. Read once, when the table is ready. |
| `exposeOptions.watch` on `@Config` | `boolean` | `false` | `true`, `false` | Written to the `Watch` column when the row is inserted. An existing row keeps its `Watch`. |
| `Watch` column of a row | `boolean` | from `exposeOptions.watch` | `0`, `1` | `1` polls the row, `0` leaves it out of the poll. |

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

- **The `Watch` column decides what is watched.** A row with `Watch` = `1` is polled although the code declares no `watch`; a row with `Watch` = `0` is not, although the code declares `watch: true`. The change takes effect on the next tick, without a restart.
- **`watch` in code seeds the column once.** A `watch` flag changed in code in a later release reaches only rows inserted from then on. Update existing rows in a migration to change them.
- **Rows no code declares are polled too.** The poll reads the table, not the options the running code declared: a watched, exposed row left over from a removed option is still written into the configuration. Clear its `Watch` or `Exposed` flag, or delete it.
- **The timer always runs.** Once the table is ready there is one query per interval, even when no row is watched.
- **The interval is fixed at startup.** Changing `__config_watch_interval__` after the exposed options were swept into the table does nothing until the next process start.
- **One query per tick.** The whole `configuration` table is read with a single query and filtered on `Watch` and `Exposed` in memory.
- **Hidden rows are not polled into the config.** A watched row with `Exposed` = `0` is skipped until the flag is set again.
- **Polled values are validated.** A `Value` that cannot be read as the row's `Type` (for example malformed JSON in a `json` row) is refused like a value that fails validation. `Configuration.set()` checks a polled value against the configuration schemas of its module. A refused value is not applied: the option keeps its previous value, and the other rows of the same poll are still applied. The refusal is logged once per slug and cause as `Watched config value <slug> from db was refused, the previous value stays`, next to the `Invalid configuration at ...` line `Configuration` logs for a value its schemas refuse. The refused row is tried again only when its `Value` changes, so later ticks log nothing and correcting the row in the database is enough. A row that is not watched or not exposed is never converted, so its content cannot stop the poll. A schema that would accept the same value, registered after the refusal, takes effect only once the row is written again.
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

`DI.resolve(DbConfigSourceBotstrapper)` returns the same singleton the bootstrap phase ran, so `refreshWatched()` writes into the configuration its timer updates.

### Start watching an option without a deploy

The option was declared without `watch`, so its row was inserted with `Watch` = `0`. Setting the column is enough; the next tick polls it.

```ts sample
import { DbConfig } from '@spinajs/configuration-db-source';

export async function watchExportBatchSize(): Promise<void> {
  await DbConfig.update({ Watch: true }).where('Slug', 'orders.export.batchSize');
}
```

## Related

- [Exposing options](02-exposing-options.md): how a row and its `Watch` column are inserted.
- [Entry types and the value converter](04-entry-types-and-converter.md): the text form to write for each type.
- [Running under authz](06-running-under-authz.md): the poll runs as `SYSTEM` when the table is guarded.
