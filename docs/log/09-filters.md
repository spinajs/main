# Filters

Filters drop or rewrite entries before they reach targets. A **logger-level** pipeline (`logger.filters`) runs once per entry for every logger; a **per-target** pipeline (`targets[].filters`) runs only for one target. Four filters ship: `LevelFilter`, `MatchFilter`, `RateLimitFilter` and `WhenRepeatedFilter`.

## How it works

1. `FrameworkLogger.resolve()` builds the logger pipeline: `logger.whenRepeated`, when set, becomes `{ type: 'WhenRepeatedFilter', ...whenRepeated }` in front of `logger.filters`. Each item resolves as `DI.resolve(item.type, [item])`.
2. For each target, `buildTargetDesc()` resolves the definition's `filters` the same way.
3. A level method passes the level gate and builds the entry.
4. `write()` runs the logger pipeline in order. Each filter's `apply(entry)` returns the entry (possibly changed) or `null`. `null` drops the entry for every target.
5. For each target whose level window holds the entry, when the target has filters, `write()` clones the entry (`{ Level, Variables: { ...Variables } }`) and runs the target pipeline on the clone. `null` drops it for that target only.

All shipped filters are `@NewInstance()`, so every logger, and every logger-target pair, has its own filter state.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.filters` | `ILogFilterOptions[]` | `[]` | `{ type, ...options }` | Logger-level pipeline, every logger. |
| `logger.targets[].filters` | `ILogFilterOptions[]` | none | `{ type, ...options }` | Per-target pipeline. |
| `logger.whenRepeated` | `{ timeout?, maxKeys? }` | off | | Deprecated shortcut for a leading `WhenRepeatedFilter`. |

### Shipped filters

| `type` | Options | Effect |
| --- | --- | --- |
| `LevelFilter` | `min` (level name, default `trace`), `max` (level name, default `security`) | Keeps entries with `min <= Level <= max`. |
| `MatchFilter` | `pattern` (regex source, required), `flags`, `field` (default `'message'`), `mode` (`'keep'` default, or `'drop'`) | Tests `String(entry.Variables[field])`. `keep`: keeps matches only. `drop`: drops matches. |
| `RateLimitFilter` | `limit` (entries per window), `intervalSeconds` (window length), `key` (variable to bucket by; global when unset) | Fixed window: keeps the first `limit` entries per window and bucket, drops the rest. Stale buckets are pruned on access. |
| `WhenRepeatedFilter` | `timeout` (s, default `10`), `maxKeys` (default `1024`) | Keyed by level, logger and message. Drops repeats inside the window (counted from the first occurrence); the next entry of that key after the window gets ` (xN)` appended, `N` being the suppressed count. |

```js
logger: {
  filters: [
    { type: 'MatchFilter', field: 'message', pattern: '^GET /health', mode: 'drop' },
    { type: 'WhenRepeatedFilter', timeout: 30 },
  ],
  targets: [
    { name: 'Console', type: 'ConsoleTarget' },
    {
      name: 'Pager',
      type: 'FileTarget',
      options: { path: 'logs/pager.log' },
      filters: [
        { type: 'LevelFilter', min: 'error' },
        { type: 'RateLimitFilter', limit: 20, intervalSeconds: 60, key: 'logger' },
      ],
    },
  ],
  rules: [{ name: '*', level: 'info', target: ['Console', 'Pager'] }],
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Log filter | the `type` string, `@Injectable('<Type>')`, `@NewInstance()` | none (empty pipeline) | `LevelFilter`, `MatchFilter`, `RateLimitFilter`, `WhenRepeatedFilter` | Write a `LogFilter`, see [Custom filters](10-custom-filters.md). Subclass a shipped one to change `keyOf()` (`RateLimitFilter`, `WhenRepeatedFilter`) or `apply()`. |

`RateLimitFilter` and `WhenRepeatedFilter` take a clock as a second constructor argument (`now: () => number`), used by tests.

## Important behaviour

- Filters run **after** the level gate: an entry below the logger's minimum level never reaches them.
- The logger pipeline runs on the shared entry; a filter that changes it (eg. `WhenRepeatedFilter`'s ` (xN)`) changes it for every target. Per-target filters work on a clone, so their changes stay with their target.
- The clone is shallow: a per-target filter that mutates a nested object inside `Variables` (eg. `error`) still changes it for other targets.
- `MatchFilter` with a missing or invalid `pattern` passes everything and prints one `console.warn`.
- `RateLimitFilter` throws `InvalidOption` when `limit` is not a number `>= 0` or `intervalSeconds` is not `> 0`. With `limit: 0` it drops everything.
- `WhenRepeatedFilter` has no timer: the ` (xN)` count appears only when the same message is logged again after the window. A burst that simply stops leaves no trace of its count.
- `WhenRepeatedFilter` keys on the formatted message, so `log.info('user %s', id)` with different ids never collapses.
- An unknown filter `type` fails the logger's resolve (or `addTarget()`) with `InvalidOption`.
- Filter state is per logger: `RateLimitFilter` in `logger.filters` limits each logger separately, not the process.

## Best practices

- Put cheap, broad drops (`MatchFilter` on health checks) first in `logger.filters`, rate limits and dedup after them.
- Use per-target filters to keep a noisy sink small without hiding entries from the console.
- Prefer rule `level` / `maxLevel` over `LevelFilter` for routing; rules raise the fast gate, filters run after the entry is built.
- Log variable data as fields so `WhenRepeatedFilter` and `MatchFilter` see a stable message.

## Patterns and antipatterns

```js
// Don't: per-request ids in the message defeat WhenRepeatedFilter
log.warn('cache miss for %s', requestId);

// Do: stable message, id as a field
log.warn({ requestId }, 'cache miss');
```

## Examples

### Keep a pager file to 20 errors a minute per logger

```js
targets: [
  {
    name: 'Pager',
    type: 'JsonFileTarget',
    options: { path: 'logs/pager.ndjson' },
    filters: [
      { type: 'LevelFilter', min: 'error' },
      { type: 'RateLimitFilter', limit: 20, intervalSeconds: 60, key: 'logger' },
    ],
  },
],
rules: [{ name: '*', level: 'error', target: 'Pager' }],
```

## Related

- [Custom filters](10-custom-filters.md): writing your own `LogFilter`.
- [Configuration and rules](02-configuration-and-rules.md): level windows, the cheaper way to split by level.
- [Runtime targets and levels](13-runtime-targets-and-levels.md): filters for a target attached at run time.
