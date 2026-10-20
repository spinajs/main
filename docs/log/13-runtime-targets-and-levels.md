# Runtime targets and levels

A resolved logger can change at run time without touching config: attach or detach a target with `addTarget()` / `removeTarget()`, and raise or lower its level with `setLevel()` and friends. Changes affect **that logger only**.

## How it works

### Attaching and detaching targets

1. `log.addTarget(def, opts?)` returns `undefined` and does nothing when `def.enabled === false`.
2. It validates `opts.level` (default `'trace'`) and `opts.maxLevel`; an unknown name throws `InvalidOption`.
3. It appends `opts.filters` after `def.filters`.
4. Any attached target with the same `def.name` is force-flushed (not awaited) and removed: names never repeat.
5. It resolves the target and its filters exactly like config routing (`buildTargetDesc()`), with the window `[level, maxLevel ?? 'security']`, and returns the target instance.
6. `recomputeGates()` sets `MinLevel` to the lowest window start of all attached targets (`trace` when none) and recomputes `${callsite}` capture.
7. `await log.removeTarget(name)` force-flushes every attached target with that name, waits for the flushes, removes them and recomputes the gates. It never disposes them. Unknown names are a no-op.

### Runtime levels

1. Each logger has a rule-derived `MinLevel` and an optional override, `LevelOverride`.
2. `getLevel()` returns the override when set, else `MinLevel`. Every level method returns at once when `level < getLevel()`.
3. `setLevel(level, persist = true)` sets the override; `level` is a `LogLevel` or a level name (`normalizeLevel()` throws on an unknown name). With `persist`, the browser stores it per logger name.
4. `resolve()` of a logger reads a stored level back into the override (browser only).

## API

| Member | Effect |
| --- | --- |
| `addTarget(def, opts?)` | `def`: a target definition (`name`, `type`, options, `filters`, `enabled`). `opts`: `{ level?, maxLevel?, filters? }`. Returns the target or `undefined`. |
| `removeTarget(name)` | `Promise<void>`; flush, then detach. |
| `getLevel()` | Effective minimum `LogLevel`. |
| `setLevel(level, persist?)` | Override the minimum. |
| `setDefaultLevel(level)` | Override only when no override is set (including a persisted one). Never persists. |
| `resetLevel()` | Drop the override and the persisted value; back to the rule-derived level. |
| `enableAll(persist?)` | `setLevel(LogLevel.Trace)`. |
| `disableAll(persist?)` | `setLevel(SILENT_LEVEL)`: even `security` is dropped. |

On the abstract `Log`, `addTarget()` returns `undefined` and `removeTarget()` resolves; `FrameworkLogger` implements them.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Runtime target attach | `addTarget()`, `removeTarget()`, protected `recomputeGates()` on `FrameworkLogger` | `FrameworkLogger` | | Subclass `FrameworkLogger` (see [Replacing the logger](17-replacing-the-logger.md)), eg. to also persist runtime targets. |
| Level persistence | `persistLevel()`, `readPersistedLevel()`, `clearPersistedLevel()` in `@spinajs/log-common` | `localStorage` key `spinajs:log:level:<logger>`, cookie fallback; no-op on Node | | Not pluggable; call the functions yourself to pre-seed levels. |

## Important behaviour

- The override applies to calls **below** it only; it cannot route an entry to a target whose window does not hold it. `setLevel('trace')` on a logger whose rules start at `info` lets `trace` calls through the gate, and then no target takes them.
- `addTarget()` recomputes `MinLevel` from the attached targets, so attaching a `trace` target lowers the gate for every target of the logger (each still filters by its own window).
- `addTarget()` resolves the target through DI: attaching a singleton type (eg. `MemoryTarget`) returns the shared instance, already holding entries from other loggers.
- The replaced target in `addTarget()` is flushed without waiting; use `removeTarget()` first when you need the flush to finish.
- `removeTarget()` also removes config-routed targets with that name.
- Runtime changes live in memory only and are lost when the logger is recreated (`Log.clearLoggers()`).
- On Node, `persist` has no effect.

## Best practices

- Attach a `@NewInstance()` target (or a dedicated type) for per-logger capture, so you do not share a singleton's buffer.
- Use `setDefaultLevel()` in app code and `setLevel()` from an admin action, so an operator's choice is not overwritten.
- Detach with `await removeTarget()` before reading a buffered target's output.

## Patterns and antipatterns

```ts
// Don't: lower the gate and expect output; no rule routes trace to a target
log.setLevel('trace');

// Do: attach a target that accepts trace for the duration of the investigation
log.addTarget({ name: 'Debug', type: 'ConsoleTarget' }, { level: 'trace' });
```

## Examples

### Turn on debug logging for one module from an admin endpoint

```ts sample
import { DI } from '@spinajs/di';
import { ITargetsOption, Log } from '@spinajs/log';

export async function setModuleDebug(loggerName: string, enabled: boolean, minutes = 15): Promise<void> {
  const log = DI.resolve(Log, [loggerName]);

  if (!enabled) {
    await log.removeTarget('AdminDebug');
    log.resetLevel();
    return;
  }

  // ITargetsOption.options is typed as ICommonTargetOptions; nested file options need a cast.
  const debugFile = { name: 'AdminDebug', type: 'JsonFileTarget', options: { path: `logs/debug-${loggerName}.ndjson` } } as unknown as ITargetsOption;

  log.addTarget(debugFile, { level: 'debug', maxLevel: 'debug' });
  log.setLevel('debug', false);

  setTimeout(() => void setModuleDebug(loggerName, false), minutes * 60_000).unref();
}
```

## Related

- [Configuration and rules](02-configuration-and-rules.md): the config-time routing these calls extend.
- [Custom targets](08-custom-targets.md#assert-on-log-output-in-a-test): capturing a logger's output with `addTarget()` in tests.
- [Browser build](18-browser-build.md): where `persist` stores levels.
