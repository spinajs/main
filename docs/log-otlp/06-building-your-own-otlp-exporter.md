# Building your own OTLP exporter

The mapping and retry helpers of this package are exported, so a target with another transport or another payload layout can produce the same OTLP records as `OtlpLogTarget`. Use this when subclassing `OtlpLogTarget` is not enough: no HTTP, a different batching rule, or one scope per logger.

## How it works

1. Write a class that extends `LogTarget<T>` from `@spinajs/log` and register it with `@Injectable("<TypeName>")`.
2. In `write(entry)`, wrap the entry in an `IOtlpRecord` with an event time in nanoseconds.
3. Build the payload with `toOtlp()`, or assemble your own envelope from `toLogRecord()`, `kv()` and `anyValue()`.
4. Deliver it. For HTTP, classify failures with `isRetryableOtlpError()` and honour `retryAfterMs()`.
5. Call `this.OnDropped?.(entry)` for every entry you give up on, so a `FallbackGroupTarget` can catch it.
6. Select the class in config with `type: "<TypeName>"`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `LogTarget<T>` | Abstract base class from `@spinajs/log`; your `@Injectable("<name>")` sets the token, `@Singleton()` or `@PerInstanceCheck()` the lifetime | none | `OtlpLogTarget`, `JsonTarget`, `FileTarget` and the other `@spinajs/log` targets | Implement `write()`; override `forceFlush()` and `dispose()` when you buffer |
| `toOtlp`, `toLogRecord`, `kv`, `anyValue` | Exported functions | The OTLP mapping described in [OTLP log record mapping](02-otlp-log-record-mapping.md) | none | Call them from your target, or post-process their result |
| `isRetryableOtlpError`, `retryAfterMs` | Exported functions | The classification described in [Delivery, retry and buffering](03-delivery-retry-and-buffering.md) | none | Use them in your own retry loop or `ResiliencePipeline` |

What each helper gives you:

| Helper | Input | Output |
| --- | --- | --- |
| `toOtlp(batch, resource?, scopeName?)` | `IOtlpRecord[]` | A complete `{ resourceLogs: [...] }` payload, one resource and one scope |
| `toLogRecord(record)` | `IOtlpRecord` | One OTLP `LogRecord` object |
| `kv(obj?)` | Plain object | `[{ key, value }]` attribute list |
| `anyValue(v)` | Any value | One OTLP `AnyValue` |
| `isRetryableOtlpError(error)` | axios-shaped error | `true` without a response, or for `429`, `502`, `503`, `504` |
| `retryAfterMs(error)` | axios-shaped error | Delay from the `retry-after` header in ms, or `undefined` |

`isRetryableOtlpError()` and `retryAfterMs()` read `error.response.status` and `error.response.headers["retry-after"]`. With `fetch` or another client, pass an object of that shape.

## Important behaviour

- **The helpers are pure.** They do no I/O and never throw; `anyValue()` falls back to a JSON string.
- **`toOtlp()` has one scope per payload.** For per-logger scopes, build the envelope yourself from `toLogRecord()`, as in the example below.
- **`timeUnixNano` must be a string** of nanoseconds since the epoch. `(BigInt(Date.now()) * 1_000_000n).toString()` is what `OtlpLogTarget` uses.
- **The base class does not buffer.** `LogTarget.forceFlush()` is a no-op; a buffering target must override it, or `Log.flush()` will not drain it.

## Best practices

- Set the same `resource` attributes as your `OtlpLogTarget` targets, so records from both arrive under one service in the backend.
- Reuse `BatchQueue` from `@spinajs/log` when you batch; it gives you the same size, interval and cap behaviour as `OtlpLogTarget`.
- Check `this.Options.enabled` at the start of `write()`; the base class does not.

## Examples

### Write OTLP JSON lines to stdout, one scope per logger

A container platform collects stdout and a Collector parses each line as an OTLP Logs payload. This target writes one line per entry, with the logger name as the instrumentation scope.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { ICommonTargetOptions, ILogEntry, LogTarget } from '@spinajs/log';
import { IOtlpRecord, kv, toLogRecord } from '@spinajs/log-otlp';

interface IOtlpStdoutTargetOptions extends ICommonTargetOptions {
  options?: {
    resource?: Record<string, string | number | boolean>;
  };
}

@PerInstanceCheck()
@Injectable('OtlpStdoutLogTarget')
export class OtlpStdoutLogTarget extends LogTarget<IOtlpStdoutTargetOptions> {
  public __checkInstance__(creationOptions: IOtlpStdoutTargetOptions[]): boolean {
    return this.Options.name === creationOptions?.[0]?.name;
  }

  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    const record: IOtlpRecord = { entry, timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString() };

    const payload = {
      resourceLogs: [
        {
          resource: { attributes: kv(this.Options.options?.resource) },
          scopeLogs: [{ scope: { name: entry.Variables.logger }, logRecords: [toLogRecord(record)] }],
        },
      ],
    };

    try {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.OnDropped?.(entry);
    }
  }
}

export const logger = {
  targets: [
    {
      name: 'OtlpStdout',
      type: 'OtlpStdoutLogTarget',
      options: { resource: { 'service.name': 'billing-api', 'k8s.namespace.name': 'payments' } },
    },
  ],
  rules: [{ name: '*', level: 'info', target: 'OtlpStdout' }],
};
```

### Retry with `fetch` using the package's classification

A minimal exporter for runtimes without axios. It reuses `toOtlp()`, `isRetryableOtlpError()` and `retryAfterMs()`, and spills what it cannot deliver to `OnDropped`.

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { ICommonTargetOptions, ILogEntry, LogTarget } from '@spinajs/log';
import { IOtlpRecord, isRetryableOtlpError, retryAfterMs, toOtlp } from '@spinajs/log-otlp';

interface IFetchOtlpTargetOptions extends ICommonTargetOptions {
  options: { endpoint: string; resource?: Record<string, string> };
}

const MAX_ATTEMPTS = 3;

@Singleton()
@Injectable('FetchOtlpLogTarget')
export class FetchOtlpLogTarget extends LogTarget<IFetchOtlpTargetOptions> {
  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    const record: IOtlpRecord = { entry, timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString() };
    void this.export([record]);
  }

  private async export(batch: IOtlpRecord[]): Promise<void> {
    const body = JSON.stringify(toOtlp(batch, this.Options.options.resource));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let failure: unknown;

      try {
        const response = await fetch(`${this.Options.options.endpoint}/v1/logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (response.ok) {
          this.HasError = false;
          return;
        }

        failure = { response: { status: response.status, headers: { 'retry-after': response.headers.get('retry-after') ?? undefined } } };
      } catch (networkError) {
        failure = networkError;
      }

      this.HasError = true;
      this.Error = failure;

      if (!isRetryableOtlpError(failure) || attempt === MAX_ATTEMPTS) {
        break;
      }

      const delay = retryAfterMs(failure) ?? 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    for (const record of batch) {
      this.OnDropped?.(record.entry);
    }
  }
}
```

## Related

- [OTLP log record mapping](02-otlp-log-record-mapping.md): what the mapping helpers produce.
- [Delivery, retry and buffering](03-delivery-retry-and-buffering.md): how `OtlpLogTarget` itself uses the retry helpers.
- [Drop hook and fallback targets](04-drop-hook-and-fallback.md): why a custom target should call `OnDropped`.
- [`@spinajs/log`](../log/README.md): the `LogTarget` contract and `BatchQueue`.
