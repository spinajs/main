# Configuration and rules

The `logger` configuration declares **targets** (where entries go) and **rules** (which logger names reach which targets at which levels). Each logger matches the rules once, on first resolve.

## How it works

1. `FrameworkLogger.resolve()` reads `logger` from `Configuration`. Missing `targets` default to one `ConsoleTarget` named `Console`; missing `rules` default to `{ name: '*', level: 'trace', target: 'Console' }`.
2. It removes duplicate target definitions with the same `name` **and** `type` (`_.uniqWith`), so two packages can ship the same console target.
3. It resolves the logger filters: `logger.whenRepeated` becomes a `WhenRepeatedFilter` in front of `logger.filters`. See [Filters](09-filters.md).
4. `matchRulesToLogger()` walks `logger.rules` in config order. It validates `name` (must be a string), `level` and `maxLevel` (must be level names) and throws `InvalidOption` otherwise. Every rule whose glob matches the logger name applies. A matched rule with `final: true` stops the walk.
5. `resolveLogTargets()` maps each applied rule to its target names:
   - a name with no definition at all throws `InvalidOption('No target matching rule ...')`;
   - a definition with `enabled: false` is skipped and never constructed;
   - each remaining definition is resolved once, by its `type`, with the definition as the constructor argument (`DI.resolve(def.type, [def])`).
6. A target reached by several rules gets the **union** of their level windows `[level, maxLevel ?? 'security']`.
7. `MinLevel` becomes the lowest `level` of the applied rules; calls below it return at once. `CaptureCallsite` turns on when a target layout contains `${callsite}`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.targets` | `ITargetsOption[]` | `[{ name: 'Console', type: 'ConsoleTarget' }]` | at least one item | Target definitions. |
| `logger.targets[].name` | `string` | required | any | Name rules refer to. |
| `logger.targets[].type` | `string` | required | a DI name registered by a target class | Target class, eg. `ConsoleTarget`, `FileTarget`, your own. |
| `logger.targets[].enabled` | `boolean` | `true` | | `false`: the target is never constructed; rules naming it skip it. |
| `logger.targets[].layout` | `string` | `${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})` | [layout](03-layouts.md) | Line format of text targets. |
| `logger.targets[].filters` | `ILogFilterOptions[]` | none | `{ type, ...options }` | Per-target filters, see [Filters](09-filters.md#how-it-works). |
| `logger.targets[].options` | `object` | depends on `type` | | Nested options of `FileTarget`, `JsonFileTarget` and the wrapper targets. |
| `logger.rules` | `ILogRule[]` | `[{ name: '*', level: 'trace', target: 'Console' }]` | at least one item | Routing rules, in evaluation order. |
| `logger.rules[].name` | `string` | required | glob | Logger name pattern. |
| `logger.rules[].level` | `string` | required | `trace` `debug` `info` `success` `warn` `error` `fatal` `security` | Lowest level routed (inclusive). |
| `logger.rules[].maxLevel` | `string` | `security` | same as `level` | Highest level routed (inclusive). |
| `logger.rules[].target` | `string \| string[]` | required | target names | Targets this rule routes to. |
| `logger.rules[].final` | `boolean` | `false` | | Stop evaluating later rules for a logger this rule matched. |
| `logger.filters` | `ILogFilterOptions[]` | `[]` | `{ type, ...options }` | Logger-level filters for every logger. |
| `logger.whenRepeated` | `{ timeout?, maxKeys? }` | off | | Deprecated: same as a leading `{ type: 'WhenRepeatedFilter', ... }` filter. |
| `logger.variables` | `object` | `{}` | | Declared on `ILogOptions`; `FrameworkLogger` does not read it. Use `addVariable()` or `LogContext`. |
| `logger.file` | `object` | see [File target](05-file-target.md#configuration) | | Defaults merged under every `FileTarget` / `JsonFileTarget` `options`. |
| `logger.perf` | `object` | see [Performance measurement](15-performance-measurement.md#configuration) | | Options of the default `LogMetricSink`. |

Some targets read their options flat on the definition (`ConsoleTarget`, `JsonTarget.stream`, `MemoryTarget.limit`), others under `options` (`FileTarget`, `JsonFileTarget`, the wrappers). Each target page says which.

```js
// config/logger.js
module.exports = {
  logger: {
    targets: [
      { name: 'Console', type: 'ConsoleTarget' },
      { name: 'Json', type: 'JsonTarget', stream: 'stdout' },
      { name: 'Audit', type: 'JsonFileTarget', options: { path: 'logs/audit.ndjson' } },
      { name: 'Ops', type: 'FileTarget', enabled: process.env.NODE_ENV === 'production', options: { path: 'logs/ops.log' } },
    ],
    filters: [{ type: 'WhenRepeatedFilter', timeout: 10 }],
    rules: [
      { name: 'db.pool', level: 'trace', target: 'Console', final: true },
      { name: '*', level: 'info', target: 'Console' },
      { name: '*', level: 'warn', maxLevel: 'error', target: 'Ops' },
      { name: 'security*', level: 'trace', target: ['Audit', 'Json'] },
    ],
  },
};
```

### Schema validation

The package registers the JSON schema `spinajs/log.configuration.schema.json` for the `logger` module at import and again in `LogBotstrapper.bootstrap()`. [`@spinajs/configuration`](../configuration/06-schema-validation.md) validates `logger` against it:

- `targets` and `rules`, when present, need at least one item and unique items;
- a target needs `name` and `type`; a rule needs `name`, `level` and `target`;
- every filter item needs `type`;
- numeric `options` of file targets are integers of at least `1`.

## Rule matching

| Pattern | Matches |
| --- | --- |
| `*` | every logger |
| `orders*` | `orders`, `orders.payments`, `ordersImport` |
| `http.*` | `http.router`, `http.server` (not `http`) |
| `checkout` | `checkout` only |

Patterns go through `glob-to-regexp` and are compiled once per process.

### Additive rules and `final`

Every matching rule applies. `orders` matched by `*` (to `Console`) and `orders*` (to `File`) writes to both, and a target reached by both rules still gets each entry once.

`final: true` on a matched rule skips the rules after it. Put a `final` rule **before** the catch-all to route a logger only there.

### Level windows

`[level, maxLevel]` is inclusive at both ends. Several rules to one target add windows, they do not merge into one range:

```js
rules: [
  { name: '*', level: 'info', maxLevel: 'info', target: 'Digest' },
  { name: '*', level: 'error', maxLevel: 'error', target: 'Digest' },
]
// Digest gets info and error, not success or warn
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Rule matching and target resolution | protected `matchRulesToLogger()`, `resolveLogTargets()`, `buildTargetDesc()` on `FrameworkLogger` | `FrameworkLogger` | none | Subclass `FrameworkLogger` and override them, then register it as `'__logImplementation__'`. See [Replacing the logger](17-replacing-the-logger.md). |
| Target class | the `type` string, resolved with `DI.resolve(type, [definition])` | `ConsoleTarget` | every target on the next pages | Register a class under a new name, or under an existing name to replace it. See [Custom targets](08-custom-targets.md). |

## Important behaviour

- Targets are resolved by `type` through DI, so a target's lifetime decides sharing. `ConsoleTarget`, `JsonTarget`, `MemoryTarget`, `BlackHoleTarget` and the wrappers are singletons: two definitions with the same `type` share one instance built from the **first** definition's options, and a logger routed to both writes each entry twice.
- `maxLevel` does not raise the fast gate: a call above every window still builds an entry, then no target takes it.
- A rule that names only disabled targets routes nowhere and raises no error. A typo in a target name throws on the first resolve of every logger the rule matches.
- Rules and targets are fixed per logger after its first resolve. Use [runtime targets](13-runtime-targets-and-levels.md) for changes at run time.
- `logger.rules` order matters only for `final`. Without `final`, order has no effect.

## Best practices

- Keep one catch-all rule (`*`) for the console or JSON stream and add specific rules for extra sinks; specific rules add, they do not replace.
- Use `enabled` driven by an environment variable to turn a sink off per environment instead of editing rules.
- Use `maxLevel` to split levels across sinks, eg. `info..warn` to a file and `error..security` to an alerting target.

## Patterns and antipatterns

```js
// Don't: the final rule comes after the catch-all, so db.pool still reaches Console
rules: [
  { name: '*', level: 'info', target: 'Console' },
  { name: 'db.pool', level: 'trace', target: 'PoolDebug', final: true },
]

// Do: final first, so db.pool goes only to PoolDebug
rules: [
  { name: 'db.pool', level: 'trace', target: 'PoolDebug', final: true },
  { name: '*', level: 'info', target: 'Console' },
]
```

```js
// Don't: two MemoryTarget definitions share one singleton (limit 500 is ignored, entries are stored twice)
targets: [
  { name: 'Recent', type: 'MemoryTarget', limit: 50 },
  { name: 'Errors', type: 'MemoryTarget', limit: 500 },
]

// Do: one definition per singleton type; split by rules or a per-target filter
targets: [{ name: 'Recent', type: 'MemoryTarget', limit: 500 }]
```

## Examples

### Route audit loggers to their own NDJSON file

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';

class AppConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          { name: 'Console', type: 'ConsoleTarget' },
          { name: 'Audit', type: 'JsonFileTarget', options: { path: 'logs/audit.ndjson' } },
        ],
        rules: [
          { name: 'audit.*', level: 'trace', target: 'Audit', final: true },
          { name: '*', level: 'info', target: 'Console' },
        ],
      },
    };
  }
}

export async function recordRoleChange(actorId: string, userId: string, role: string): Promise<void> {
  DI.register(AppConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const audit = DI.resolve(Log, ['audit.roles']);
  audit.security({ actorId, userId, role }, '${actorId} granted ${role} to ${userId}');
}
```

## Related

- [Logging API](01-logging-api.md): how a logger is resolved and what it writes.
- [Filters](09-filters.md): `logger.filters` and `targets[].filters`.
- [`@spinajs/configuration`](../configuration/README.md): config files, environments and schema validation.
