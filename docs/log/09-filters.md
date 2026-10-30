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
| `RateLimitFilter` | `limit`, `intervalSeconds` (both required), `key`, `logger`, `where`, `level`, `maxLevel`, `maxKeys`, `reportSuppressed`; see [RateLimitFilter](#ratelimitfilter) | Fixed window: of the entries it is scoped to, keeps the first `limit` per window and bucket and drops the rest. The next kept entry of a bucket says how many were dropped. |
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

## RateLimitFilter

Bounds how many lines a source can write, however its input varies. Use it for lines a client or a peer can trigger at will: refused requests, rejected messages, failed webhooks. The caller logs every occurrence; the filter decides how many reach the targets.

### Options

| Option | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `limit` | `number` | required | integer `>= 0` | Entries kept per window and bucket. `0` drops every entry the filter applies to. |
| `intervalSeconds` | `number` | required | finite, `> 0` | Window length. A window opens with the first entry of its bucket, not on a clock tick. |
| `key` | `string \| string[]` | one bucket | variable names | Variables the bucket is keyed by, eg. `'logger'` or `['origin', 'ownOrigin']`. Fields of a fields-form call are variables, so any field works. A missing variable counts as its own value. |
| `logger` | `string \| string[]` | every logger | globs, as in rules | Limit only entries of these loggers (`entry.Variables.logger`). Others pass untouched. |
| `where` | `Record<string, string \| number \| boolean>` | every entry | | Limit only entries whose variables equal (`===`) all of these. Others pass untouched. |
| `level` | level name | `trace` | `trace` .. `security` | Lowest level limited (inclusive). Entries below pass untouched. |
| `maxLevel` | level name | `security` | `trace` .. `security` | Highest level limited (inclusive). Entries above pass untouched. |
| `maxKeys` | `number` | `1024` | integer `>= 1` | Buckets kept in memory. |
| `reportSuppressed` | `boolean` | `true` | | Note drops on the next kept entry of the bucket. |

A missing or invalid `limit`, `intervalSeconds` or `maxKeys`, or an unknown level name, throws `InvalidOption` when the logger resolves, so a broken limit fails the boot instead of silently letting everything through.

### How it works

1. **Scope.** `applies(entry)` checks `level` / `maxLevel`, then `logger`, then `where`. An entry outside the scope is returned as it is and touches no counter.
2. **Bucket.** `keyOf(entry)` builds the bucket key from the `key` variables, or one shared bucket without `key`.
3. **Window.** No bucket yet, or its window is `intervalSeconds` old: a new window opens with this entry as its first. Otherwise the entry is counted.
4. **Keep or drop.** Up to `limit` entries per window are kept. The rest return `null` and are counted as dropped.
5. **Report.** With `reportSuppressed`, the first entry of a bucket's next window gets ` (N suppressed)` appended to its message and a `suppressed: N` variable, `N` being what the previous window dropped.
6. **Memory.** A new bucket past `maxKeys` first drops expired windows, then the bucket whose window opened first. A dropped bucket's unreported count is lost and the bucket starts fresh.

### Bucket and total limits together

One filter has one bucket dimension. To keep both "one line per pair" and "N lines in all", chain two filters with the same scope. The second only sees what the first kept:

```js
logger: {
  filters: [
    // One line per (origin, ownOrigin) pair a minute...
    { type: 'RateLimitFilter', logger: 'authn-http', where: { event: 'authn-http.csrf-refused' }, key: ['origin', 'ownOrigin'], limit: 1, intervalSeconds: 60, maxKeys: 256 },
    // ...and 20 a minute in all, so varying the pair does not help.
    { type: 'RateLimitFilter', logger: 'authn-http', where: { event: 'authn-http.csrf-refused' }, limit: 20, intervalSeconds: 60 },
  ],
}
```

This is the configuration `@spinajs/authn-http` ships for its `CsrfOriginGuard` refusal lines. `logger.filters` concatenates, so it joins your own filters. Filters only drop entries, so a filter of your own on the same entries can tighten the limit but not loosen it.

### Where the state lives

`RateLimitFilter` is `@NewInstance()`. In `logger.filters`, every logger resolves its own instance, so a filter without `logger` limits each logger separately, never the process as a whole. In `targets[].filters`, every logger-target pair has its own instance. `@spinajs/log` caches loggers by name, so one name means one instance for the process.

### Writing lines that a filter can limit

- Put the data in fields, not in the message: `key` and `where` read variables.
- Give the line a stable marker field, such as `event`, so `where` limits that line and nothing else of the logger.
- Clip client input before logging it (the limit counts lines, not bytes).

## Important behaviour

- Filters run **after** the level gate: an entry below the logger's minimum level never reaches them.
- The logger pipeline runs on the shared entry; a filter that changes it (eg. `WhenRepeatedFilter`'s ` (xN)`) changes it for every target. Per-target filters work on a clone, so their changes stay with their target.
- The clone is shallow: a per-target filter that mutates a nested object inside `Variables` (eg. `error`) still changes it for other targets.
- `MatchFilter` with a missing or invalid `pattern` passes everything and prints one `console.warn`.
- `RateLimitFilter` without a valid `limit` (integer `>= 0`) and `intervalSeconds` (`> 0`) throws `InvalidOption` when the logger resolves. With `limit: 0` it drops every entry it applies to.
- `RateLimitFilter` has no timer either: a ` (N suppressed)` note appears only when the bucket logs again after its window. A burst that simply stops leaves only the `null`s.
- `RateLimitFilter` in the logger pipeline appends its note to the shared entry, so every target sees it. Two chained `RateLimitFilter`s that both dropped can append two notes; the `suppressed` variable holds the last one.
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

```js
// Don't: a bucket per client value with no total cap. Varying the value gets one line per request
// (up to maxKeys distinct values per window).
{ type: 'RateLimitFilter', key: 'ip', limit: 1, intervalSeconds: 60 }

// Do: chain a total cap with the same scope
{ type: 'RateLimitFilter', where: { event: 'login-refused' }, key: 'ip', limit: 1, intervalSeconds: 60 },
{ type: 'RateLimitFilter', where: { event: 'login-refused' }, limit: 50, intervalSeconds: 60 },
```

```js
// Don't: an unscoped limit in logger.filters also drops the logger's errors
{ type: 'RateLimitFilter', limit: 10, intervalSeconds: 60 }

// Do: limit only the noisy levels
{ type: 'RateLimitFilter', maxLevel: 'warn', limit: 10, intervalSeconds: 60 }
```

## Examples

### Limit one noisy logger, never its errors

```js
logger: {
  filters: [{ type: 'RateLimitFilter', logger: 'queue.*', maxLevel: 'warn', key: 'message', limit: 5, intervalSeconds: 30 }],
}
```

Every `queue.*` logger keeps up to 5 entries per distinct message every 30 s at `warn` and below; `error`, `fatal` and `security` always pass, as do all other loggers.

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
