# Custom targets

A target is a class extending `LogTarget`, registered in DI under a string that config uses as `type`. Write one to send entries somewhere new, change how a shipped target formats them, or replace a shipped target under its own name.

## How it works

1. `@Injectable('<Type>')` registers the class under the string `'<Type>'` when its module is imported.
2. A rule routes a logger to a definition with `type: '<Type>'`. `FrameworkLogger.buildTargetDesc()` calls `DI.resolve('<Type>', [definition])`.
3. DI builds the class with the definition as the only constructor argument. `LogTarget`'s constructor merges it over `{ enabled: true, layout: <default layout> }` into `this.Options`.
4. DI calls `resolve()` (`LogTarget` is a `SyncService`): do synchronous setup there and start async work without awaiting it.
5. `FrameworkLogger.write()` calls `write(entry)` for every entry in the target's level window, after the logger and per-target filters.
6. `log.flush()`, `Log.flushAll()` and `removeTarget()` call `forceFlush()`. The DI container calls `dispose()` on teardown.

## Configuration

A custom target reads whatever keys you put on its definition. Flat keys arrive on `this.Options`; nest them under `options` when you want the `FileTarget` style. Shared keys: `name`, `type`, `enabled`, `layout`, `filters`.

```js
{ name: 'Intake', type: 'HttpIntakeTarget', url: 'https://logs.example.com/v1/batch', apiKey: '${env:LOG_INTAKE_KEY}', batchSize: 200 }
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Log target | the `type` string, `@Injectable('<Type>')`; lifetime from your decorator | `ConsoleTarget` for the default rule | every shipped target | New name: register a class under it. Same name as a shipped target: register after `@spinajs/log` is imported; the last registration wins. Subclass a shipped target to change one method. |
| Line format of file targets | protected `formatEntry(entry)` on `FileTarget` | layout | `JsonFileTarget` | Subclass `FileTarget`, override `formatEntry()`, keep `@PerInstanceCheck()`. |

### `LogTarget` contract

| Member | Contract |
| --- | --- |
| `constructor(options)` | Receives the target definition. Call `super(options)`, then apply your defaults with `Object.assign({ ...defaults }, this.Options)`. |
| `Options` | Merged definition. |
| `write(entry)` | Abstract. Return `void` or a `Promise`. Reject (throw) to signal "not accepted": `RetryingTarget` and `FallbackGroupTarget` act on it. Check `this.Options.enabled` first. |
| `forceFlush()` | Drain buffered entries. Default resolves at once. |
| `OnDropped` | Set by `FallbackGroupTarget`. Call `this.OnDropped?.(entry)` for every entry you give up on. |
| `HasError`, `Error` | Last error state, for health checks. |
| `resolve()` | Synchronous setup; call `super.resolve()`. |
| `dispose()` | Teardown: stop timers, final flush. |

### Choosing a lifetime

| Decorator | Instances | Use for |
| --- | --- | --- |
| `@Singleton()` | One per type; built from the first definition resolved | Stateless sinks with one definition (console-like). |
| `@NewInstance()` | One per logger and definition | Recording targets in tests; cheap stateless sinks. Buffered targets get one buffer per logger. |
| `@PerInstanceCheck()` + `__checkInstance__(opts)` | Reused while `__checkInstance__` returns `true` for the definition | Writers keyed by definition, eg. by `name`. DI caches only the first instance of the class; see [File target](05-file-target.md#important-behaviour). |

### Custom target: ship batches to an HTTP intake

A buffered, self-healing target: `write()` only enqueues and always resolves; a failed batch is requeued; entries dropped on overflow go to `OnDropped`.

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { BatchQueue, ICommonTargetOptions, ILogEntry, LogLevelToSeverityNumber, LogTarget, safeStringify } from '@spinajs/log';

interface IHttpIntakeTargetOptions extends ICommonTargetOptions {
  url: string;
  apiKey?: string;
  batchSize?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
}

// config: { name: 'Intake', type: 'HttpIntakeTarget', url: 'https://logs.example.com/v1/batch', apiKey: '...', batchSize: 200 }
@Singleton()
@Injectable('HttpIntakeTarget')
export class HttpIntakeTarget extends LogTarget<IHttpIntakeTargetOptions> {
  protected Queue!: BatchQueue<ILogEntry>;

  constructor(options: IHttpIntakeTargetOptions) {
    super(options);
    this.Options = Object.assign({ batchSize: 100, maxQueue: 10_000, flushIntervalMs: 2000 }, this.Options);
  }

  public resolve(): void {
    this.Queue = new BatchQueue<ILogEntry>({
      maxBatch: this.Options.batchSize!,
      maxQueue: this.Options.maxQueue!,
      flushIntervalMs: this.Options.flushIntervalMs!,
      exportTimeoutMs: 5000,
      onFlush: (batch) => this.send(batch),
      onOverflow: (dropped) => dropped.forEach((e) => this.OnDropped?.(e)),
    });
    super.resolve();
  }

  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }
    void this.Queue.enqueue(entry);
  }

  public forceFlush(): Promise<void> {
    return this.Queue.forceFlush().catch(() => undefined);
  }

  public async dispose(): Promise<void> {
    await this.Queue.shutdown().catch(() => undefined);
  }

  protected async send(batch: ILogEntry[]): Promise<void> {
    const body = batch.map((e) => safeStringify({ time: new Date().toISOString(), severityNumber: LogLevelToSeverityNumber[e.Level], ...e.Variables })).join('\n');

    try {
      const res = await fetch(this.Options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson', ...(this.Options.apiKey ? { authorization: `Bearer ${this.Options.apiKey}` } : {}) },
        body,
      });

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        batch.forEach((e) => this.OnDropped?.(e));
        return;
      }
      if (!res.ok) {
        throw new Error(`intake answered ${res.status}`);
      }

      this.HasError = false;
      this.Error = null;
    } catch (err) {
      this.HasError = true;
      this.Error = err;
      this.Queue.requeueFront(batch);
    }
  }
}
```

### Extending `FileTarget`: change only the line format

Override `formatEntry()` to keep buffering, the write lock, rotation, retention and zipping. This target writes logfmt lines.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { FileTarget, ILogEntry } from '@spinajs/log';

// config: { name: 'Logfmt', type: 'LogfmtFileTarget', options: { path: 'logs/app.logfmt' } }
@PerInstanceCheck()
@Injectable('LogfmtFileTarget')
export class LogfmtFileTarget extends FileTarget {
  protected formatEntry(entry: ILogEntry): string {
    const { level, logger, message, error, ...fields } = entry.Variables;
    const pairs: Record<string, unknown> = { ts: new Date().toISOString(), level, logger, msg: message, ...fields };

    if (error) {
      pairs.err = (error as unknown as { message?: string }).message;
    }

    return Object.entries(pairs)
      .filter(([, v]) => v !== undefined && typeof v !== 'object' && typeof v !== 'function')
      .map(([k, v]) => `${k}=${/[\s="]/.test(String(v)) ? JSON.stringify(String(v)) : String(v)}`)
      .join(' ');
  }
}
```

### Taking part in fallback chains

- Strict target: throw or reject from `write()` when the entry is not delivered. `FallbackGroupTarget` then tries the next target at once.
- Self-healing target: resolve from `write()`, retry internally, and call `this.OnDropped?.(entry)` when you give up. `FallbackGroupTarget` sets `OnDropped` to the next target's `write()`.
- Never do both for the same entry, or the fallback gets it twice.

## Important behaviour

- A `@Singleton()` target is built from the **first** definition resolved; later definitions of the same type reuse it with the first options.
- Targets are resolved when the first logger routed to them resolves, not at boot. An error thrown from the constructor or `resolve()` fails that logger's resolve.
- A target registered after a logger resolved is not used by that logger. Import target modules before the first `DI.resolve(Log, ...)`.
- `FrameworkLogger` checks only that the definition's name exists. An unregistered `type` resolves to `null`, and every later log call routed to it throws `InvalidOperation('Target <name> for rule <rule> not exists')` into your code. Spell `type` exactly as the `@Injectable` string, and import the target module before the first logger resolves.
- Entries reach the target after filters; per-target filters run on a shallow clone of `Variables`, so mutating `entry.Variables` in `write()` can leak into other targets that have no filters. Copy before you change it.
- The layout is not applied for you; call `format(entry.Variables, this.Options.layout)` from `@spinajs/configuration` when your target writes text.

## Best practices

- Check `this.Options.enabled` at the top of `write()`; runtime-added and wrapped targets rely on it.
- Use `BatchQueue` for any network or disk target: size and interval triggers, a hard cap and `requeueFront()` are already there, and its timers are `unref()`'d.
- Implement `forceFlush()` and `dispose()` for buffered targets, or `Log.flushAll()` cannot drain them.
- Serialize with `safeStringify()`; a circular field must not break logging.

## Patterns and antipatterns

```ts
// Don't: a network call per entry that throws into the logger on every outage
public async write(entry: ILogEntry) {
  await fetch(this.Options.url, { method: 'POST', body: JSON.stringify(entry.Variables) });
}

// Do: buffer, requeue on failure, report give-ups through OnDropped (see HttpIntakeTarget above)
public write(entry: ILogEntry) {
  void this.Queue.enqueue(entry);
}
```

## Examples

### Assert on log output in a test

```ts sample
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { ICommonTargetOptions, ILogEntry, Log, LogTarget } from '@spinajs/log';

@NewInstance()
@Injectable('RecordingTarget')
export class RecordingTarget extends LogTarget<ICommonTargetOptions> {
  public Records: ILogEntry[] = [];

  public write(entry: ILogEntry): void {
    this.Records.push(entry);
  }
}

export function captureWarnings(loggerName: string, run: (log: Log) => void): string[] {
  const log = DI.resolve(Log, [loggerName]);
  const recorder = log.addTarget({ name: 'Recorder', type: 'RecordingTarget' }, { level: 'warn' }) as RecordingTarget;

  run(log);
  void log.removeTarget('Recorder');

  return recorder.Records.map((e) => String(e.Variables.message));
}
```

## Related

- [Wrapper targets](07-wrapper-targets.md): what the rejection contract and `OnDropped` drive.
- [Console, JSON and memory targets](04-console-json-memory-targets.md#replacing-the-console-target-one-line-json-in-production-colors-in-development): replacing a shipped target under its own name.
- [`@spinajs/di` lifetimes](../di/04-lifetimes.md): `@Singleton()`, `@NewInstance()`, `@PerInstanceCheck()`.
