# Logger contract

`Log` is the abstract logger every SpinaJS package writes to. Code depends on `Log` and gets a logger from DI or the `@Logger()` decorator; the implementation is whatever is registered under `Log`, which is `FrameworkLogger` from [`@spinajs/log`](../log/README.md) in a normal app.

## How it works

1. **Get a logger.** `DI.resolve(Log, [name])` or a `@Logger(name)` property calls the factory registered under `Log`. `@spinajs/log` registers one that returns the cached logger from `Log.Loggers` for that name, or creates a `FrameworkLogger`.
2. **Log a message.** `log.info(...)` (or any level method) checks `isEnabled(level)`, which compares the level with `getLevel()`. Below it, the call returns at once.
3. **Build the entry.** The implementation turns the arguments into an `ILogEntry` with `createLogMessageObject()`; see [Log entries](03-log-entries.md).
4. **Dispatch.** `log.write(entry)` hands the entry to the logger's targets and resolves with one `PromiseSettledResult` per target. In `FrameworkLogger`, a target whose `write()` rejects shows up as a `rejected` result; a target that throws synchronously makes the log call itself throw.
5. **Drain.** `log.flush()` calls `forceFlush()` on every target of the logger. `Log.flushAll()` does this for every logger in `Log.Loggers`. `Log.clearLoggers()` flushes, disposes and forgets them.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Logger(name, variables?)` | Class property | `name`: logger name. `variables`: passed to the `Log` factory as the second option | Defines a lazy getter on the prototype. The first read resolves the logger: an already resolved `Log` with that `Name`, else `DI.resolve(Log, [name, variables])`. All instances of the class share the logger. |
| `@Logger(name, { optional: true, variables? })` | Class property | `optional`: do not require a registered `Log` | While no `Log` is registered, the property reads as `consoleLog` and resolution is retried on the next read. Once a `Log` resolves it is kept. Type the property as `LogWriter`. A second argument is read as options only when it has a boolean `optional` and no keys but `optional` and `variables`. |

## API

### Static members

| Member | Meaning |
| --- | --- |
| `Log.Loggers: Map<string, Log>` | Loggers by name. `FrameworkLogger.resolve()` adds itself here; `flushAll()` and `clearLoggers()` walk it. |
| `Log.InternalLoggers: Map<string, Log>` | Bootstrap loggers created before the configuration module exists (`@spinajs/internal-logger`). |
| `Log.flushAll(): Promise<void>` | `flush()` on every logger in `Loggers`. Never rejects. |
| `Log.clearLoggers()` | `flushAll()`, then `dispose()` every logger in `Loggers`, clears `Loggers`, then calls `dispose()` on every `InternalLoggers` entry. |

### Instance members

| Member | Meaning |
| --- | --- |
| `Name: string` | Logger name. Rules in `@spinajs/log` match it with globs. |
| `trace` `debug` `info` `success` `warn` `error` `fatal` `security` | Abstract. Each has four call forms: `(message, ...args)`, `(err, message, ...args)`, `(fields, message?, ...args)` and `(err \| string, message \| any[], ...args)`. |
| `write(entry): Promise<PromiseSettledResult<void>[]>` | Abstract. Dispatch a built entry. |
| `child(name, variables?)` | `DI.resolve(Log, ['<Name>.<name>', { ...this.Variables, ...variables }, this])`. |
| `addVariable(name, value)` | Sets `Variables[name]`; implementations merge `Variables` into every entry. |
| `timeStart(name)` / `timeEnd(name): number` | Start a named timer; `timeEnd` returns elapsed ms and removes it. A second `timeStart` with a running name is ignored; `timeEnd` of an unknown name returns `0`. |
| `getLevel()`, `setLevel()`, `setDefaultLevel()`, `resetLevel()`, `enableAll()`, `disableAll()` | Runtime level control; see [Log levels](02-log-levels.md#runtime-level-control). |
| `flush(): Promise<void>` | `forceFlush()` on each target in `Targets`; never rejects. A logger with no targets resolves at once. |
| `addTarget(def, opts?)` | Attach a target at runtime. The base returns `undefined`; `FrameworkLogger` overrides it. |
| `removeTarget(name): Promise<void>` | Detach a runtime target. The base resolves at once; `FrameworkLogger` overrides it. |

### Protected members a subclass uses

| Member | Meaning |
| --- | --- |
| `Container: Container` | Injected with `@Autoinject()` when DI builds the logger. |
| `Variables: Record<string, any>` | Logger-wide variables, `{}` by default. |
| `Options: ILogOptions`, `Rules: ILogRule[]`, `Targets: ILogTargetDesc[]` | Routing state, filled by the implementation. `flush()` reads `Targets`. |
| `MinLevel: LogLevel` | Lowest level any target accepts. Default `LogLevel.Trace`. |
| `LevelOverride: LogLevel \| null` | Runtime override; `null` means use `MinLevel`. |
| `isEnabled(level): boolean` | `level >= getLevel()`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Logger | `Log` (class token), registered as a factory, so no DI caching; the factory caches by name in `Log.Loggers` | `@spinajs/log`: `logFactoryFunction` returns `Log.Loggers.get(name)`, an `InternalLoggerProxy` while `Configuration` is not registered, else `FrameworkLogger` (`@NewInstance()`, also under `'__logImplementation__'`) | `InternalLoggerProxy` (`@spinajs/internal-logger`), `ElectronRendererLogger` (`@spinajs/electron`, forwards calls over IPC) | Replace: `DI.register(myFactory).as(Log)` after `@spinajs/log` is imported; the last registration wins. Extend: subclass `FrameworkLogger` and register it as `'__logImplementation__'`, so the shipped factory keeps its caching and bootstrap fallback. |

### Log: custom implementation

Implement `Log` when log calls must go somewhere other than the `@spinajs/log` pipeline: a test recorder, an IPC bridge, a host's own logger.

- Implement the eight level methods and `write()`. One implementation signature per level method covers all four call forms.
- Use `createLogMessageObject()` so entries look like `FrameworkLogger`'s; use `renderTemplate()` for the fields form.
- Call `isEnabled(level)` first, so `setLevel()` and `disableAll()` work.
- Add each logger to `Log.Loggers`, so `Log.flushAll()` and `Log.clearLoggers()` reach it.
- Register a factory, not the class: callers pass `[name, variables, parent]` as resolve options, and the factory decides between a cached and a new logger.

```ts sample
import { DI, IContainer } from '@spinajs/di';
import { createLogMessageObject, ILogEntry, Log, LogLevel, renderTemplate } from '@spinajs/log-common';

// Records entries in memory, for asserting on log output in unit tests.
class RecordingLog extends Log {
  public static readonly Entries: ILogEntry[] = [];

  constructor(name: string, variables?: Record<string, unknown>) {
    super();
    this.Name = name;
    this.Variables = { ...variables };
  }

  public trace(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Trace, err, message, args);
  }
  public debug(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Debug, err, message, args);
  }
  public info(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Info, err, message, args);
  }
  public success(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Success, err, message, args);
  }
  public warn(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Warn, err, message, args);
  }
  public error(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Error, err, message, args);
  }
  public fatal(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Fatal, err, message, args);
  }
  public security(err: Error | string | object, message?: string | any[], ...args: any[]): void {
    this.emit(LogLevel.Security, err, message, args);
  }

  public write(entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    RecordingLog.Entries.push(entry);
    return Promise.resolve([]);
  }

  private emit(level: LogLevel, err: Error | string | object, message: string | any[] | undefined, args: any[]): void {
    if (!this.isEnabled(level)) return;

    let entry: ILogEntry;
    if (err instanceof Error) {
      entry = createLogMessageObject(err, message as string, level, this.Name, this.Variables, ...args);
    } else if (typeof err === 'string') {
      const formatArgs = message === undefined ? args : [message, ...args];
      entry = createLogMessageObject(err, '', level, this.Name, this.Variables, ...formatArgs);
    } else {
      const fields = err as Record<string, unknown>;
      const text = typeof message === 'string' ? renderTemplate(message, fields) : '';
      entry = createLogMessageObject('', text, level, this.Name, { ...this.Variables, ...fields });
    }
    void this.write(entry);
  }
}

// Forwards the variables `child()` and `@Logger()` pass, and caches by name.
const recordingLogFactory = (_container: IContainer, name: string, variables?: Record<string, unknown>): Log => {
  const existing = Log.Loggers.get(name);
  if (existing) return existing;

  const created = new RecordingLog(name, variables);
  Log.Loggers.set(name, created);
  return created;
};

DI.register(recordingLogFactory).as(Log);

const log = DI.resolve(Log, ['billing']);
log.addVariable('service', 'invoices');
log.info('Invoice %s paid', 'INV-7');
log.child('stripe').warn({ invoiceId: 'INV-7' }, 'Webhook retried for ${invoiceId}');

console.log(RecordingLog.Entries.map((e) => `${e.Variables.logger} ${e.Variables.level} ${e.Variables.message}`));
// [ 'billing INFO Invoice INV-7 paid', 'billing.stripe WARN Webhook retried for INV-7' ]
```

## Logging without a registered Log

Library code that may run before or without `@spinajs/log` writes through a `LogWriter`: the eight level methods of `Log` and nothing else.

| Export | Meaning |
| --- | --- |
| `LogWriter` | `Pick<Log, 'trace' \| 'debug' \| 'info' \| 'success' \| 'warn' \| 'error' \| 'fatal' \| 'security'>`. |
| `consoleLog` | A `LogWriter` on the console. `trace` and `debug` are dropped; `info` and `success` go to `console.info`, `warn` to `console.warn`, the rest to `console.error`. A fields-form call is rendered with `renderTemplate()`, and a `fields.error` is printed after the line. Never throws. |
| `optionalLog(name, resolveLog?)` | A `LogWriter` for the logger `name`. It calls `DI.resolve(Log, [name])` only when `DI.check(Log)` is true, and keeps the result once it gets one, so a `Log` registered later is picked up. While there is none, or when resolving or writing throws, the call goes to `consoleLog`. `resolveLog` is a test seam. |

## Rate-limited and once-only logging

| Export | Meaning |
| --- | --- |
| `RateLimitedLog(log, options?)` | Writes at most one line per key per `intervalMs` (default 60 000; `Infinity` writes each key once). `maxPerInterval` (default unlimited) caps lines across all keys in one interval. `maxKeys` (default 256) bounds memory: past it, the key written longest ago is forgotten. Methods `error`, `warn`, `info`, `debug` and `write(level, ...)` take the key first, then the usual call form, and return whether they wrote. |
| `warnOnce(log, key, ...args)` | Writes the warning only the first time the process sees `key`; returns whether it wrote. Keys are shared by all callers, so prefix them with the package name. Up to 1024 keys are remembered. |
| `resetWarnOnce()` | Forgets the `warnOnce` keys. For tests. |

`log` is a `LogWriter` (a `Log` is one) or a getter called on every write. When the getter returns `undefined` or throws, or the write throws, the line goes to `consoleLog`.

A line that follows suppressed lines of its key ends with `(N more suppressed)`. In the fields form the fields also get `suppressed: N`.

```ts sample
import { RateLimitedLog, optionalLog, warnOnce } from '@spinajs/log-common';

const log = optionalLog('csrf');
const refusals = new RateLimitedLog(log, { intervalMs: 60_000, maxPerInterval: 20 });

const origin = 'https://evil.example';
refusals.warn(`refused|${origin}`, { origin }, 'Refused a cookie request from ${origin}');
warnOnce(log, 'csrf:no-origins', 'csrf: no allowed origins configured');
```

## Important behaviour

- `Log` is registered as a **factory**. DI never caches the result; reuse comes from `Log.Loggers`. Two `DI.resolve(Log, ['x'])` calls return the same object only when the factory caches by name.
- `child()` and `@Logger(name, variables)` pass `variables` as the second resolve option. The `@spinajs/log` factory reads only the name, so with `FrameworkLogger` those variables are dropped and a cached logger of that name is returned as it is. Use `addVariable()` on the returned logger instead.
- `child()` types its `variables` parameter as `LogVariables`, which requires `error`, `level`, `logger` and `message`; a plain `{ provider: 'stripe' }` does not compile. Another reason to call `addVariable()` on the child.
- `child()` does not inherit level overrides, targets or rules from the parent. The child is a separate logger named `<parent>.<name>`; `@spinajs/log` rules match that full name.
- `@Logger()` defines a non-configurable getter on the prototype. Assigning to the property throws a `TypeError` in a class (strict mode). Declare it as `protected Log!: Log;` with no initializer, and keep `useDefineForClassFields: false`, or the class field hides the getter.
- Without a registered `Log`, a plain `@Logger()` read returns a bare `Log` instance whose level methods are undefined, so the first write throws a `TypeError`. Use `{ optional: true }` or `optionalLog()` in code that can run without one.
- `@Logger()` resolves on first read, not at class definition. A logger read before the configuration module is registered is an `InternalLoggerProxy` when `@spinajs/log` is in use.
- `timeStart()` and `timeEnd()` measure wall-clock time with `Date`; they do not log anything.
- `Log.flushAll()` reaches only loggers in `Log.Loggers`. A custom `Log` that does not add itself is never flushed on shutdown.
- `Log.clearLoggers()` disposes `InternalLoggers` but does not clear that map or await those disposals.

## Best practices

- Type fields and parameters as `Log`, never `FrameworkLogger`. Tests can then register a recorder, as in the sample above.
- Name loggers by module, dotted (`orm.mysql`, `http.auth`), so `@spinajs/log` rules can route `orm.*` in one rule.
- Call `await Log.flushAll()` before `process.exit()`. `@spinajs/log` drains on `beforeExit` only, which hard exits skip.

## Patterns and antipatterns

```ts
// Don't: the getter from @Logger() is not writable; this throws a TypeError at construction.
class InvoiceService {
  @Logger('billing')
  protected Log: Log = DI.resolve(Log, ['billing']);
}

// Do
class InvoiceService {
  @Logger('billing')
  protected Log!: Log;
}
```

```ts
// Don't: with @spinajs/log the variables never reach the child logger.
const log = parent.child('stripe', { provider: 'stripe' });

// Do
const log = parent.child('stripe');
log.addVariable('provider', 'stripe');
```

## Examples

### Time a nightly export and log its duration

```ts sample
import { Logger, Log } from '@spinajs/log-common';

class NightlyExport {
  @Logger('jobs.export')
  protected Log!: Log;

  public async run(rows: () => Promise<number>): Promise<void> {
    this.Log.timeStart('export');
    const count = await rows();
    const ms = this.Log.timeEnd('export');
    this.Log.info({ count, ms }, 'Exported ${count} rows in ${ms} ms');
  }
}

void new NightlyExport().run(async () => 1250);
```

### Flush every logger before a hard exit

```ts sample
import { Log } from '@spinajs/log-common';

process.on('SIGTERM', () => {
  void Log.flushAll().then(() => process.exit(0));
});
```

## Related

- [Log levels](02-log-levels.md): the level methods and runtime overrides.
- [Log entries](03-log-entries.md): what an implementation builds from the call arguments.
- [Log targets](06-log-targets.md): what `write()` dispatches to and `flush()` drains.
- [`@spinajs/log`](../log/README.md): `FrameworkLogger`, rules, `addTarget()` and `removeTarget()`.
- [`@spinajs/di` factories](../di/08-factories.md): why a factory registration is never cached.
