# Log filters

A `LogFilter` sees each entry before the targets do and keeps it, changes it or drops it. Filters are DI services registered under a string name, listed in config per logger or per target, and run in order. This package ships the base class and `WhenRepeatedFilter`, which collapses repeated entries.

## How it works

1. **Register.** A filter class is decorated `@Injectable('<TypeName>')` and, when it keeps state, `@NewInstance()`.
2. **Configure.** `logger.filters` (every entry of every logger) or `logger.targets[].filters` (one target) lists `{ type, ...options }` specs.
3. **Resolve.** `FrameworkLogger.resolve()` (in `@spinajs/log`) calls `DI.resolve(spec.type, [spec])` for each spec. The spec reaches the constructor as `options`.
4. **Apply, logger level.** `FrameworkLogger.write()` runs the logger filters in order on the entry. A `null` drops the entry for every target.
5. **Apply, target level.** For each target with filters, the logger copies the entry (`{ Level, Variables: { ...Variables } }`) and runs that target's filters on the copy. A `null` drops the entry for that target only.

Filters run after the level gate, so a call below the logger's level never reaches them.

## API

| Export | Meaning |
| --- | --- |
| `LogFilter` | Abstract. `constructor(protected options?: ILogFilterOptions)`; `abstract apply(entry: ILogEntry): ILogEntry \| null`. Return the entry (changed or not) to keep it, `null` to drop it. |
| `ILogFilterOptions` | `{ type: string; [k: string]: unknown }`: the config spec. |
| `WhenRepeatedFilter` | Collapses identical entries within a time window. |
| `IWhenRepeatedOptions` | `{ timeout?: number; maxKeys?: number }` plus the spec keys. |

`LogFilter` does not extend `SyncService`; DI calls no `resolve()` on it.

## Configuration

### `WhenRepeatedFilter`

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.filters[].type` | `string` | required | `WhenRepeatedFilter` | Selects the filter. |
| `logger.filters[].timeout` | `number` | `10` | Seconds, `>= 1` in the `@spinajs/log` schema for `whenRepeated` | Window, from the first occurrence, in which repeats are suppressed. |
| `logger.filters[].maxKeys` | `number` | `1024` | `>= 1` | Cap on tracked keys. |

```ts
export default {
  logger: {
    filters: [{ type: 'WhenRepeatedFilter', timeout: 30 }],
    targets: [
      { name: 'Console', type: 'ConsoleTarget' },
      // Only this target drops debug noise.
      { name: 'Audit', type: 'FileTarget', options: { path: 'audit.log' }, filters: [{ type: 'LevelFilter', level: 'info' }] },
    ],
    rules: [{ name: '*', level: 'debug', target: ['Console', 'Audit'] }],
  },
};
```

### How `WhenRepeatedFilter` decides

1. The key is `` `${Level}|${logger}|${message}` `` (`keyOf()`), using the formatted message.
2. First occurrence of a key: emit and start tracking with count `0`.
3. Same key within `timeout` of the window start and not a higher level: suppress, count `+1`.
4. Window expired, or the same key at a higher level: emit, append ` (xN)` to `message` when `N > 0` suppressed, reset the window.
5. Above `maxKeys` tracked keys, `prune()` drops expired keys, then the oldest.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Log filter | The string `type`; the class's lifetime. Resolved by name with `[spec]` | none here (abstract) | `WhenRepeatedFilter` (here); `LevelFilter`, `MatchFilter`, `RateLimitFilter` (`@spinajs/log`) | New filter: subclass `LogFilter`, `@Injectable('<NewType>')`, `@NewInstance()` when it keeps state. Replace a shipped type by registering under the same string after it is imported. |
| `WhenRepeatedFilter` | `'WhenRepeatedFilter'`, `@NewInstance()`: each logger and each target spec gets its own instance and state | itself | none | Subclass and override `keyOf(entry)` (what counts as "the same"), `prune(now)` (memory policy) or `apply()`. Register the subclass under a new name, or under `'WhenRepeatedFilter'` to change `logger.whenRepeated` too. |

### LogFilter: custom implementation

Write a filter to sample, redact, enrich or route entries by content. Keep `apply()` synchronous and cheap; it runs for every entry. Use `@NewInstance()` whenever the filter holds state, or one instance is shared by every logger and only the first spec's options are used.

```ts sample
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { createLogMessageObject, ILogEntry, ILogFilterOptions, LogFilter, LogLevel } from '@spinajs/log-common';

interface ISampleFilterOptions extends ILogFilterOptions {
  /** Keep 1 of every `every` entries at or below `maxLevel`. */
  every?: number;
  maxLevel?: LogLevel;
}

// Keeps a sample of chatty low-level entries; warnings and errors always pass.
@NewInstance()
@Injectable('SampleFilter')
class SampleFilter extends LogFilter {
  private seen = 0;

  constructor(protected options?: ISampleFilterOptions) {
    super(options);
  }

  public apply(entry: ILogEntry): ILogEntry | null {
    if (entry.Level > (this.options?.maxLevel ?? LogLevel.Debug)) return entry;
    this.seen++;
    return this.seen % (this.options?.every ?? 10) === 1 ? entry : null;
  }
}

const filter = DI.resolve<SampleFilter>('SampleFilter', [{ type: 'SampleFilter', every: 100 }]);

let kept = 0;
for (let i = 0; i < 1000; i++) {
  if (filter.apply(createLogMessageObject('Cache hit %d', '', LogLevel.Debug, 'cache', {}, i))) kept++;
}
console.log(kept); // 10
```

In config: `logger.filters: [{ type: 'SampleFilter', every: 100 }]`.

### WhenRepeatedFilter: extending it

Override `keyOf()` when entries that differ only in ids, ports or counters should count as repeats.

```ts sample
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { createLogMessageObject, ILogEntry, LogLevel, WhenRepeatedFilter } from '@spinajs/log-common';

// "Connection to 10.0.0.5:5432 refused" and "... 10.0.0.6:5432 ..." collapse together.
@NewInstance()
@Injectable('LooseRepeatFilter')
class LooseRepeatFilter extends WhenRepeatedFilter {
  protected keyOf(entry: ILogEntry): string {
    return `${entry.Level}|${entry.Variables.logger}|${entry.Variables.message.replace(/\d+/g, '#')}`;
  }
}

const filter = DI.resolve<LooseRepeatFilter>('LooseRepeatFilter', [{ type: 'LooseRepeatFilter', timeout: 60 }]);
const refused = (host: string) => createLogMessageObject('Connection to %s refused', '', LogLevel.Error, 'db.pool', {}, host);

console.log(filter.apply(refused('10.0.0.5:5432')) !== null); // true: first one is emitted
console.log(filter.apply(refused('10.0.0.6:5432')) !== null); // false: counted as a repeat
```

## Important behaviour

- A filter's default lifetime is singleton, like any `@Injectable` class. Without `@NewInstance()`, all loggers and targets share one instance, built with the first spec it was resolved with.
- Logger-level filters change the entry every target gets. Target-level filters work on a shallow copy, so a changed `message` stays with that target; nested objects are still shared.
- `WhenRepeatedFilter` has no timer. A suppressed count is reported only when the same key is logged again after the window; if it never repeats, the count is never written.
- `WhenRepeatedFilter` keys on the formatted message. Messages with changing values (`Retry 1`, `Retry 2`) never repeat; override `keyOf()` or log the value as a field.
- `logger.whenRepeated` (deprecated) and a `WhenRepeatedFilter` in `logger.filters` both apply when both are set: the deprecated one is prepended.
- A spec `type` with no registration is not reported at config load or logger resolve: DI returns `null` for an unknown string key, and the logger throws a `TypeError` on its first write. Import the module that registers the filter before the first logger resolves.

## Best practices

- Put cheap, dropping filters (level, sampling) first, and changing filters (redaction) after them.
- Use a target-level filter to keep one target quiet (eg. no debug in the file) instead of a second logger.
- Keep filters free of I/O; a slow filter delays every log call.

## Patterns and antipatterns

```ts
// Don't: a stateful filter without @NewInstance() shares one counter across all loggers.
@Injectable('SampleFilter')
class SampleFilter extends LogFilter { private seen = 0; /* ... */ }

// Do
@NewInstance()
@Injectable('SampleFilter')
class SampleFilter extends LogFilter { private seen = 0; /* ... */ }
```

## Related

- [Log targets](06-log-targets.md): `logger.targets[].filters`.
- [Log entries](03-log-entries.md): what a filter receives.
- [`@spinajs/log`](../log/README.md): `LevelFilter`, `MatchFilter`, `RateLimitFilter` and the filter pipeline in `FrameworkLogger`.
