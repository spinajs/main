# Custom filters

A filter is a class extending `LogFilter`, registered in DI under a string that config uses as `type`. It sees every entry of its pipeline and returns it (changed or not) to keep it, or `null` to drop it.

## How it works

1. `@Injectable('<Type>')` registers the class under `'<Type>'` when its module is imported.
2. `FrameworkLogger.resolve()` (for `logger.filters`) and `buildTargetDesc()` (for `targets[].filters`) call `DI.resolve('<Type>', [item])`. The config item, `type` included, is the constructor argument and lands in the protected `options`.
3. `write()` calls `apply(entry)` on each filter in order. See [Filters](09-filters.md#how-it-works) for where each pipeline runs.

## Configuration

Any keys next to `type` reach your constructor:

```js
filters: [{ type: 'RedactFilter', fields: ['password', 'token', 'authorization'], mask: '[redacted]' }]
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Log filter | the `type` string, `@Injectable('<Type>')`; use `@NewInstance()` | none | the [shipped filters](09-filters.md#shipped-filters) | Subclass `LogFilter` and implement `apply()`. Subclass a shipped filter to override `apply()` or `keyOf()`. Register under a shipped name to replace it everywhere. |

### `LogFilter` contract

| Member | Contract |
| --- | --- |
| `constructor(options?)` | Receives the config item. Call `super(options)`, read and validate your keys once. |
| `options` | Protected; the config item. |
| `apply(entry)` | Return the entry to keep it, a changed entry to rewrite it, `null` to drop it. Synchronous. Must not throw: an exception propagates out of the log call. |

`LogFilter` is not a `SyncService`, but it is built by DI, so `@Autoinject()` properties work.

### Custom filter: redact secrets before any target sees them

Copy `Variables` before you change them: in the logger pipeline, the entry object is shared by every target.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ILogEntry, ILogFilterOptions, LogFilter } from '@spinajs/log';

interface IRedactFilterOptions extends ILogFilterOptions {
  fields?: string[];
  mask?: string;
}

// config: logger.filters: [{ type: 'RedactFilter', fields: ['password', 'token', 'authorization'] }]
@Injectable('RedactFilter')
@NewInstance()
export class RedactFilter extends LogFilter {
  protected fields: Set<string>;
  protected mask: string;

  constructor(options?: IRedactFilterOptions) {
    super(options);
    this.fields = new Set((options?.fields ?? ['password', 'token']).map((f) => f.toLowerCase()));
    this.mask = options?.mask ?? '[redacted]';
  }

  public apply(entry: ILogEntry): ILogEntry {
    const hits = Object.keys(entry.Variables).filter((k) => this.fields.has(k.toLowerCase()));
    if (hits.length === 0) {
      return entry;
    }

    const variables = { ...entry.Variables };
    for (const key of hits) {
      variables[key] = this.mask;
    }
    return { Level: entry.Level, Variables: variables };
  }
}
```

### Extending a shipped filter: rate-limit per logger and level

`RateLimitFilter.keyOf()` picks the bucket. Override it to bucket on two fields.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ILogEntry, RateLimitFilter } from '@spinajs/log';

// config: targets[].filters: [{ type: 'LoggerLevelRateLimitFilter', limit: 10, intervalSeconds: 60 }]
@Injectable('LoggerLevelRateLimitFilter')
@NewInstance()
export class LoggerLevelRateLimitFilter extends RateLimitFilter {
  protected keyOf(entry: ILogEntry): string {
    return `${entry.Variables.logger}|${entry.Level}`;
  }
}
```

## Important behaviour

- A filter without `@NewInstance()` is a singleton shared by every logger and target that names it; its state (counters, windows) is shared too.
- Filters are resolved when a logger resolves. A filter module imported later is not used by loggers already resolved.
- An unknown `type` fails the logger's resolve (or `addTarget()`) with `InvalidOption`.
- `apply()` runs on the caller's call stack for every entry: keep it cheap and synchronous.
- Returning a new entry object is fine; `write()` uses whatever the last filter returns.

## Best practices

- Validate options in the constructor and fall back to a pass-through, like `MatchFilter` does, so a bad config never drops everything.
- Return a copy when you change `Variables` in a logger-level filter.
- Bound any per-key state (prune expired keys, cap the map) the way `WhenRepeatedFilter` caps at `maxKeys`.

## Patterns and antipatterns

```ts
// Don't: mutate the shared entry in place in a logger-level filter
public apply(entry: ILogEntry) {
  entry.Variables.password = '***';
  return entry;
}

// Do: copy, then change
public apply(entry: ILogEntry) {
  return { Level: entry.Level, Variables: { ...entry.Variables, password: '***' } };
}
```

## Examples

### Keep only one in ten debug entries

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ILogEntry, ILogFilterOptions, LogFilter, LogLevel } from '@spinajs/log';

// config: targets[].filters: [{ type: 'DebugSampleFilter', every: 10 }]
@Injectable('DebugSampleFilter')
@NewInstance()
export class DebugSampleFilter extends LogFilter {
  protected seen = 0;
  protected every: number;

  constructor(options?: ILogFilterOptions & { every?: number }) {
    super(options);
    this.every = Math.max(1, options?.every ?? 10);
  }

  public apply(entry: ILogEntry): ILogEntry | null {
    if (entry.Level > LogLevel.Debug) {
      return entry;
    }
    return this.seen++ % this.every === 0 ? entry : null;
  }
}
```

## Related

- [Filters](09-filters.md): pipelines, ordering and the shipped filters.
- [Custom targets](08-custom-targets.md): the other string-registered extension point.
- [`@spinajs/di` lifetimes](../di/04-lifetimes.md): why `@NewInstance()` matters for stateful filters.
