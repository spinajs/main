# Extending the OTLP target

`OtlpLogTarget` is an ordinary DI class: subclass it to change what it exports, how it retries or how it talks HTTP, and register the subclass under a new name or in place of the original. Use this when the configuration keys are not enough: redaction, a different retry policy, rotating credentials, export metrics.

## How it works

1. `@Injectable("OtlpLogTarget")` registers the class under the string name `"OtlpLogTarget"` and under itself. `@PerInstanceCheck()` sets its lifetime: one instance per target `name`.
2. A logger resolves each target with `DI.resolve(def.type, [def])`. For a string name, DI picks the **last** class registered under it.
3. DI constructs the class with `def` as the only constructor argument, sets `@Autoinject()` properties, then calls `resolve()`.
4. `resolve()` builds `AxiosInstance`, `RetryPipeline` and `Queue`, in that order, then marks the service resolved.
5. At run time the logger calls `write()`; the queue calls `send()`; `Log.flush()` calls `forceFlush()`; DI teardown calls `dispose()`.

So a subclass has two ways in:

- **A new name** (`@Injectable("RedactingOtlpLogTarget")`): config selects it per target with `type`. The original stays available.
- **The same name** (`@Injectable("OtlpLogTarget")`): every target with `type: "OtlpLogTarget"` now builds your class. The module that declares it must be imported before the first logger resolves its targets, that is, before the first `DI.resolve(Log, ...)` or `@Logger()` property access.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `OtlpLogTarget` | `"OtlpLogTarget"` and `OtlpLogTarget`, `@PerInstanceCheck()` | `OtlpLogTarget` | none shipped | Subclass with `@Injectable("<name>")` and `@PerInstanceCheck()`; or `DI.register(MyTarget).as("OtlpLogTarget")` |
| `write(entry)` | Public method | Wraps the entry with a timestamp and enqueues it | none | Override to enrich, redact or skip entries, then call `super.write()` |
| `resolve()` | Public method, called once by DI | Builds `AxiosInstance`, `RetryPipeline`, `Queue` | none | Override, call `super.resolve()` first, then replace or decorate those fields |
| `AxiosInstance` | Protected field | `axios.create({ baseURL: endpoint, headers, timeout })` | any `AxiosInstance` | Add interceptors or assign a new instance after `super.resolve()` |
| `RetryPipeline` | Protected field | 5 retries, exponential 1 s to 5 s, jitter, `Retry-After` capped at 5 s | any `ResiliencePipeline<void>` | Assign a new pipeline after `super.resolve()` |
| `send(batch)` | Protected method, the queue's `onFlush` | Export, then requeue or drop | none | Override and call `super.send()`; an override must resolve, never reject |
| `__checkInstance__(options)` | Public method, used by `@PerInstanceCheck()` | Same instance when `name` and `endpoint` match | none | Override to share instances by another key, for example `endpoint` alone |

Protected members you can use from a subclass:

| Member | Type | Use |
| --- | --- | --- |
| `Log` | `Log` | The target's own logger, named `LogOtlpTarget` |
| `Queue` | `BatchQueue<IOtlpRecord>` | `size`, `flush()`, `requeueFront()` |
| `Overflowed` | `boolean` | `true` between an overflow and the next successful export |
| `AxiosInstance` | `AxiosInstance` | The HTTP client |
| `RetryPipeline` | `ResiliencePipeline<void>` | The retry policy around the POST |

Keep these rules in a subclass:

- Re-apply `@PerInstanceCheck()`. A property decorator such as `@Autoinject()` gives the subclass its own DI descriptor, whose default lifetime is singleton; without the class decorator every target name would share one instance.
- Call `super.resolve()` before touching `AxiosInstance`, `RetryPipeline` or `Queue`: they do not exist before it.
- Keep `write()` synchronous and non-throwing. The logger does not await it.

### Redact secrets before export

Override `write()` to change entries before they are buffered. This target removes credential fields and masks card numbers in the message.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { ILogEntry } from '@spinajs/log';
import { OtlpLogTarget } from '@spinajs/log-otlp';

const SECRET_FIELDS = ['password', 'authorization', 'apiKey', 'refreshToken'];

@PerInstanceCheck()
@Injectable('RedactingOtlpLogTarget')
export class RedactingOtlpLogTarget extends OtlpLogTarget {
  public write(entry: ILogEntry): void {
    const variables = { ...entry.Variables };

    for (const field of SECRET_FIELDS) {
      if (field in variables) {
        variables[field] = '[redacted]';
      }
    }

    variables.message = variables.message.replace(/\b\d{12,19}\b/g, '[card]');

    super.write({ ...entry, Variables: variables });
  }
}

export const logger = {
  targets: [
    {
      name: 'Otlp',
      type: 'RedactingOtlpLogTarget',
      options: { endpoint: 'http://otel-collector:4318', resource: { 'service.name': 'billing-api' } },
    },
  ],
  rules: [{ name: '*', level: 'info', target: 'Otlp' }],
};
```

### Change the retry policy

Override `resolve()` and replace `RetryPipeline`. This version, registered under `"OtlpLogTarget"`, replaces the target for every config: it retries up to 10 times, also retries `500`, and caps `Retry-After` at 30 s.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { OtlpLogTarget, isRetryableOtlpError, retryAfterMs } from '@spinajs/log-otlp';
import { BackoffType, ResiliencePipelineBuilder, TimeSpan } from '@spinajs/util';

const MAX_RETRY_AFTER_MS = 30_000;

function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

@PerInstanceCheck()
@Injectable('OtlpLogTarget')
export class PatientOtlpLogTarget extends OtlpLogTarget {
  public resolve(): void {
    super.resolve();

    this.RetryPipeline = new ResiliencePipelineBuilder<void>()
      .addRetry({
        MaxRetryAttempts: 10,
        Delay: TimeSpan.fromSeconds(1),
        MaxDelay: TimeSpan.fromSeconds(30),
        BackoffType: BackoffType.Exponential,
        UseJitter: true,
        ShouldHandle: (outcome) => outcome.Error !== undefined && (isRetryableOtlpError(outcome.Error) || statusOf(outcome.Error) === 500),
        DelayGenerator: ({ Outcome }) => {
          const ms = retryAfterMs(Outcome.Error);
          return ms !== undefined ? TimeSpan.fromMilliseconds(Math.min(ms, MAX_RETRY_AFTER_MS)) : undefined;
        },
      })
      .build();
  }
}
```

`send()` still uses `isRetryableOtlpError()` to choose between requeue and drop once the pipeline gives up. In this example a `500` is retried 10 times, then dropped.

### Send a short-lived bearer token on every export

Add an axios request interceptor after `super.resolve()`. The token comes from a DI service, so you can swap it in tests.

```ts sample
import { Autoinject, Injectable, PerInstanceCheck, Singleton } from '@spinajs/di';
import { OtlpLogTarget } from '@spinajs/log-otlp';

@Singleton()
export class CollectorTokenProvider {
  private token = '';
  private expiresAt = 0;

  public async get(): Promise<string> {
    if (Date.now() < this.expiresAt - 30_000) {
      return this.token;
    }

    const response = await fetch('https://auth.internal.example.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'otlp.write' }),
    });
    const body = (await response.json()) as { access_token: string; expires_in: number };

    this.token = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
  }
}

@PerInstanceCheck()
@Injectable('OAuthOtlpLogTarget')
export class OAuthOtlpLogTarget extends OtlpLogTarget {
  @Autoinject()
  protected Tokens: CollectorTokenProvider;

  public resolve(): void {
    super.resolve();

    this.AxiosInstance.interceptors.request.use(async (config) => {
      config.headers.Authorization = `Bearer ${await this.Tokens.get()}`;
      return config;
    });
  }
}
```

A token request that fails rejects the export with an error that has no HTTP response, so it counts as retryable.

### Measure every export

Override `send()` and delegate to `super.send()`, which never rejects. This keeps the requeue and drop handling intact.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { IOtlpRecord, OtlpLogTarget } from '@spinajs/log-otlp';

export interface IOtlpExportStats {
  exports: number;
  failedExports: number;
  records: number;
  lastDurationMs: number;
}

@PerInstanceCheck()
@Injectable('MeasuredOtlpLogTarget')
export class MeasuredOtlpLogTarget extends OtlpLogTarget {
  public readonly Stats: IOtlpExportStats = { exports: 0, failedExports: 0, records: 0, lastDurationMs: 0 };

  protected async send(batch: IOtlpRecord[]): Promise<void> {
    const started = performance.now();

    await super.send(batch);

    this.Stats.exports++;
    this.Stats.records += batch.length;
    this.Stats.lastDurationMs = performance.now() - started;
    if (this.HasError) {
      this.Stats.failedExports++;
    }
  }
}
```

### Share one instance per endpoint

Override `__checkInstance__()` when several target names should reuse one exporter and one buffer, for example per-module targets that all point at the same collector.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { IOtlpTargetOptions, OtlpLogTarget } from '@spinajs/log-otlp';

@PerInstanceCheck()
@Injectable('SharedOtlpLogTarget')
export class SharedOtlpLogTarget extends OtlpLogTarget {
  public __checkInstance__(creationOptions: IOtlpTargetOptions[]): boolean {
    const wanted = creationOptions?.[0] as (IOtlpTargetOptions & { options?: Partial<IOtlpTargetOptions> }) | undefined;
    const endpoint = wanted?.options?.endpoint ?? wanted?.endpoint;
    return endpoint !== undefined && endpoint === this.Options.endpoint;
  }
}
```

## Important behaviour

- **Last registration wins.** Two classes registered under `"OtlpLogTarget"` resolve to the one imported last. Import order decides; keep replacements in one module your app imports explicitly.
- **Replacing after targets are built has no effect.** Loggers resolve their targets once, in their own `resolve()`. A registration made later applies only to loggers created later.
- **`resolve()` runs once per instance.** Fields you set there stay for the target's lifetime; per-request values belong in an interceptor or in `write()`.
- **`write()` overrides see the entry before the target copies the timestamp.** The OTLP `timeUnixNano` is taken in `super.write()`.
- **`send()` overrides run inside the queue's single flush slot.** Slow work there delays every following export.

## Best practices

- Prefer a new DI name over replacing `"OtlpLogTarget"`: config then shows which class each target uses, and the original stays available for other targets.
- Copy `entry.Variables` before changing it, as in the redaction example. The same entry object can be dispatched to other targets.
- Reuse `isRetryableOtlpError()` and `retryAfterMs()` in a custom pipeline instead of re-implementing status checks.

## Patterns and antipatterns

```ts
// Don't: RetryPipeline does not exist yet; super.resolve() overwrites it anyway.
public resolve(): void {
  this.RetryPipeline = myPipeline;
  super.resolve();
}

// Do: build the defaults first, then replace them.
public resolve(): void {
  super.resolve();
  this.RetryPipeline = myPipeline;
}
```

```ts
// Don't: without @PerInstanceCheck() the @Autoinject property gives the class a singleton
// descriptor, so every target name resolves to the first instance.
@Injectable('OAuthOtlpLogTarget')
export class OAuthOtlpLogTarget extends OtlpLogTarget {
  @Autoinject()
  protected Tokens: CollectorTokenProvider;
}

// Do
@PerInstanceCheck()
@Injectable('OAuthOtlpLogTarget')
export class OAuthOtlpLogTarget extends OtlpLogTarget {
  @Autoinject()
  protected Tokens: CollectorTokenProvider;
}
```

## Related

- [OTLP log target](01-otlp-log-target.md): the configuration a subclass inherits.
- [Delivery, retry and buffering](03-delivery-retry-and-buffering.md): the contract of `send()` and the default retry policy.
- [Building your own OTLP exporter](06-building-your-own-otlp-exporter.md): when subclassing is not enough.
- [Lifetimes](../di/04-lifetimes.md) and [Named services](../di/07-named-services.md): `@PerInstanceCheck()` and string registrations.
