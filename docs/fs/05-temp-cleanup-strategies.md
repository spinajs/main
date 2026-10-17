# Temp cleanup strategies

A cleanup strategy decides which temp files are stale, deletes them, and owns the schedule of its sweeps. Every [temp file system](04-temp-file-system.md) gets its own strategy instance, picked by class name in `cleanupStrategy`.

## How it works

1. `fsTemp.resolve()` reads `cleanupStrategy` (default `MaxAgeTempCleanupStrategy`).
2. It looks the name up among the classes registered under `TempCleanupStrategy` (`DI.RootContainer.Registry.getTypes(TempCleanupStrategy)`, matched on class name). No match throws `ResolveException`.
3. It resolves the class. Strategies are `@NewInstance()`, so each temp provider gets its own instance and schedule.
4. When `cleanup` is `true`, it calls `start(backend, options)`. `backend` is the raw backend provider; `options` is the whole temp provider entry, custom keys included.
5. The schedule calls `safeCleanup(backend, options)`, which runs `cleanup()` and logs a warning instead of throwing.
6. `fsTemp.dispose()` calls `stop()`.

## Configuration

Strategies read the temp provider entry. See [Temp file system](04-temp-file-system.md#configuration) for `cleanup`, `cleanupStrategy`, `maxFileAge`, `cleanupInterval` and `cleanupCronExpression`. Custom strategies can read extra keys from the same entry.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TempCleanupStrategy` | `TempCleanupStrategy`, `@NewInstance()`; picked by class name, not by last registration | `MaxAgeTempCleanupStrategy` | `CronTempCleanupStrategy` | Subclass `TempCleanupStrategy` (or a shipped strategy), decorate with `@Injectable(TempCleanupStrategy)` and `@NewInstance()`, set `cleanupStrategy` to its class name. |

### Shipped strategies

| Strategy | Schedule | Sweep |
| --- | --- | --- |
| `MaxAgeTempCleanupStrategy` | `setInterval`, every `cleanupInterval` ms (default 10 minutes) | Lists `/` of the backend, deletes each entry whose age exceeds `maxFileAge` seconds (default 1 hour). |
| `CronTempCleanupStrategy` | `CronJob` on `cleanupCronExpression`; `start()` throws `InvalidOption` when it is missing or invalid | Same sweep, inherited from `MaxAgeTempCleanupStrategy`. |

The sweep takes the age from `CreationTime`, or from `ModifiedTime` when `CreationTime` is missing, invalid or not after the epoch (S3 and FTP backends). An entry with neither is skipped. A failing `stat()` or `rm()` on one entry is logged and the sweep goes on.

### Abstract members

| Member | Contract |
| --- | --- |
| `cleanup(fs, options)` | One sweep over the backend. |
| `start(fs, options)` | Starts the schedule. Must not leak an earlier schedule when called twice. |
| `stop()` | Stops the schedule. Safe to call more than once. |
| `safeCleanup(fs, options)` | Protected. Wraps `cleanup()` in a try/catch with a warning log; call it from your schedule. |
| `Logger` | Protected `Log` for the `fs` logger. |

### Custom strategy: cap temp storage size

Replace the policy when age is the wrong signal, eg. a disk with a fixed quota. This one deletes the oldest files until the total size fits `maxTotalSize`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { fs, IFsTempOptions, IStat, TempCleanupStrategy } from '@spinajs/fs';

interface IQuotaTempOptions extends IFsTempOptions {
  maxTotalSize?: number;
}

// config: { service: 'fsTemp', name: 'fs-temp', provider: 'fs-temp-local', cleanup: true,
//           cleanupStrategy: 'QuotaTempCleanupStrategy', cleanupInterval: 60000, maxTotalSize: 2147483648 }
@Injectable(TempCleanupStrategy)
@NewInstance()
export class QuotaTempCleanupStrategy extends TempCleanupStrategy {
  protected timer: NodeJS.Timeout | null = null;

  public start(backend: fs, options: IFsTempOptions): void {
    this.stop();
    this.timer = setInterval(() => void this.safeCleanup(backend, options), options.cleanupInterval ?? 60_000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async cleanup(backend: fs, options: IFsTempOptions): Promise<void> {
    const limit = (options as IQuotaTempOptions).maxTotalSize ?? 1024 * 1024 * 1024;
    const entries: { name: string; stat: IStat }[] = [];

    for (const name of await backend.list('/')) {
      entries.push({ name, stat: await backend.stat(name) });
    }

    entries.sort((a, b) => (a.stat.ModifiedTime?.toMillis() ?? 0) - (b.stat.ModifiedTime?.toMillis() ?? 0));

    let total = entries.reduce((sum, e) => sum + (e.stat.Size ?? 0), 0);
    for (const entry of entries) {
      if (total <= limit) {
        break;
      }

      await backend.rm(entry.name);
      total -= entry.stat.Size ?? 0;
      this.Logger.trace({ path: entry.name }, 'Temp quota exceeded, deleted ${path}');
    }
  }
}
```

Import the module before `fsService` resolves, so the class is registered when `fsTemp` looks it up.

### Extending a shipped strategy: sweep once at startup

Subclass a shipped strategy to keep its sweep and change one part. This one also sweeps right after boot, so files left by a crashed process do not wait for the first interval.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { fs, IFsTempOptions, MaxAgeTempCleanupStrategy, TempCleanupStrategy } from '@spinajs/fs';

// config: cleanupStrategy: 'SweepOnStartTempCleanupStrategy'
@Injectable(TempCleanupStrategy)
@NewInstance()
export class SweepOnStartTempCleanupStrategy extends MaxAgeTempCleanupStrategy {
  public start(backend: fs, options: IFsTempOptions): void {
    super.start(backend, options);
    void this.safeCleanup(backend, options);
  }
}
```

## Important behaviour

- The strategy is selected by **class name**; registering a new one does not replace the default for providers that do not name it.
- A strategy registered without `@NewInstance()` is a singleton: two temp providers would share one schedule, and the second `start()` would stop the first.
- `start()` runs inside `fsTemp.resolve()`, so an exception there fails the whole `fsService` boot.
- Both shipped strategies sweep the backend root only, not subdirectories.
- `CronTempCleanupStrategy` logs a warning when `cleanupInterval` is also set, and ignores it.

## Best practices

- Call `safeCleanup()`, not `cleanup()`, from your schedule: a remote backend that fails must not crash a timer callback.
- Call `this.stop()` at the start of `start()`.
- Put custom keys of your strategy in the temp provider entry and type them with an interface extending `IFsTempOptions`.

## Patterns and antipatterns

```ts
// Don't: singleton strategy, shared by every temp provider
@Injectable(TempCleanupStrategy)
export class NightlyCleanup extends CronTempCleanupStrategy {}

// Do
@Injectable(TempCleanupStrategy)
@NewInstance()
export class NightlyCleanup extends CronTempCleanupStrategy {}
```

## Examples

### Nightly sweep with the cron strategy

```ts sample
const config = {
  fs: {
    defaultProvider: 'fs-temp',
    providers: [
      { service: 'fsNative', name: 'fs-temp-local', basePath: './data/temp' },
      {
        service: 'fsTemp',
        name: 'fs-temp',
        provider: 'fs-temp-local',
        cleanup: true,
        cleanupStrategy: 'CronTempCleanupStrategy',
        cleanupCronExpression: '0 30 2 * * *',
        maxFileAge: 12 * 60 * 60,
      },
    ],
  },
};

export default config;
```

## Related

- [Temp file system](04-temp-file-system.md): the provider that runs the strategy.
- [Custom providers](06-custom-providers.md): what `list()` and `stat()` must return for the sweep to work.
