# Extending the Loki target

`GraphanaLokiLogTarget` is a plain DI class with protected members you override in a subclass. Use a subclass to add HTTP headers (eg. a Loki tenant), change the retry policy, reshape or redact the payload, or change which definitions share one instance. Register the subclass under its own type name, or under `GraphanaLogTarget` to swap it in for every existing config.

## How it works

1. The logger resolves each target with `DI.resolve(definition.type, [definition])`. The `type` string is the DI key; a single resolve takes the **last** registration under that key.
2. `@Injectable("Name")` on your subclass registers it under `Name` when its module is imported. `DI.register(Sub).as("GraphanaLogTarget")` replaces the default for configs that already use `GraphanaLogTarget`.
3. The lifetime comes from `@PerInstanceCheck()`. A subclass inherits it through the class metadata; repeat the decorator on the subclass to make it explicit.
4. DI constructs the subclass with the definition, then calls `resolve()`. Your `resolve()` validates its own options, calls `super.resolve()` (which builds `AxiosInstance`, `RetryPipeline` and `Queue`), then changes what it needs.
5. Every flush calls `this.send(batch)`, which reads `this.AxiosInstance` and `this.RetryPipeline` at call time, so fields replaced in `resolve()` take effect on the first push.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Loki log target | String `GraphanaLogTarget` and the class `GraphanaLokiLogTarget`; `@PerInstanceCheck()`, cached per `name`; resolved by the logger from `logger.targets[].type` | `GraphanaLokiLogTarget` | none shipped | Subclass with `@PerInstanceCheck() @Injectable("MyType")` and use `type: "MyType"`; or `DI.register(Sub).as("GraphanaLogTarget")` after importing this package. |
| HTTP client `AxiosInstance` | Protected field, built in `resolve()` | `axios.create({ baseURL: host, headers, timeout })` | none | Override `resolve()`: call `super.resolve()`, then add headers or interceptors, or assign a new instance. |
| Retry policy `RetryPipeline` | Protected `ResiliencePipeline<void>`, built in `resolve()` | retry, 5 retries, exponential 1 s to 5 s, jitter, `Retry-After` | none | Override `resolve()`: call `super.resolve()`, assign a pipeline from `ResiliencePipelineBuilder<void>`. |
| Payload and failure handling `send(batch)` | Protected method, the `BatchQueue` `onFlush` | groups into streams, posts, requeues or drops | none | Override; transform the batch and call `super.send()`, or replace it. It must resolve, never reject. |
| Instance identity `__checkInstance__(creationOptions)` | `IInstanceCheck`, called by DI on each cached instance | same `name` means same instance | none | Override to compare more keys, eg. `name` and `host`. |
| Entry intake `write(entry)` | Public method, called by the logger | stamps `n_timestamp`, enqueues | none | Override to filter or enrich entries, then call `super.write()`. |

| Member | Visibility | Runs | Override to |
| --- | --- | --- | --- |
| `constructor(options)` | public | once, by DI | Read extra options; call `super(options)` first. Nested `options` keys are already flat on `this.Options` after it. |
| `resolve()` | public | once, after construction | Replace `AxiosInstance`, `RetryPipeline`; call `super.resolve()` first. |
| `write(entry)` | public | for every routed entry | Filter or enrich before buffering. |
| `send(batch)` | protected | for every flush | Change the payload, redact, or change the requeue-or-drop decision. |
| `forceFlush()`, `dispose()` | public | on `log.flush()` and container disposal | Add teardown; call the base method. |
| `__checkInstance__(creationOptions)` | public | on every DI resolve of the type | Change which definitions share an instance. |
| `Log` | protected, `@Logger("LogLokiTarget")` | lazily | Inherited; use it for your own diagnostics. |

### Loki target: custom implementation

Multi-tenant Loki reads the tenant from the `X-Scope-OrgID` header. This subclass reads a `tenant` key from the target definition and sets the header on its HTTP client. It registers under its own type, so the default target stays available.

```ts sample
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';
import { GraphanaLokiLogTarget, IGraphanaOptions } from '@spinajs/log-source-graphana-loki';

interface ITenantLokiOptions extends IGraphanaOptions {
  tenant: string;
}

@PerInstanceCheck()
@Injectable('TenantLokiTarget')
export class TenantLokiTarget extends GraphanaLokiLogTarget {
  public resolve(): void {
    const { tenant } = this.Options as ITenantLokiOptions;
    if (!tenant) {
      throw new Error(`Loki target ${this.Options.name} needs a "tenant" option`);
    }

    super.resolve();
    this.AxiosInstance.defaults.headers.common['X-Scope-OrgID'] = tenant;
  }
}

class AppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'TenantLoki',
            type: 'TenantLokiTarget',
            options: {
              host: 'http://loki-gateway:3100',
              tenant: 'acme-corp',
              labels: { app: 'billing-api' },
            },
          },
        ],
        rules: [{ name: '*', level: 'info', target: 'TenantLoki' }],
      },
    };
  }
}

async function main() {
  DI.register(AppConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const log = DI.resolve(Log, ['billing']);
  log.info('Monthly invoices generated');
  await log.flush();
}

void main();
```

### Replace the default registration

Register the subclass under `GraphanaLogTarget` when existing configs must pick it up without a change. Do it after `@spinajs/log-source-graphana-loki` is imported, because its `@Injectable` registers the default at import time and the last registration wins. Do it before the first logger resolves its targets; a cached target instance is not replaced.

```ts sample
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { GraphanaLokiLogTarget } from '@spinajs/log-source-graphana-loki';

@PerInstanceCheck()
@Injectable()
export class GatewayLokiTarget extends GraphanaLokiLogTarget {
  public resolve(): void {
    super.resolve();
    this.AxiosInstance.defaults.headers.common['X-Scope-OrgID'] = process.env.LOKI_TENANT ?? 'default';
  }
}

// Every `type: "GraphanaLogTarget"` definition now builds a GatewayLokiTarget.
DI.register(GatewayLokiTarget).as('GraphanaLogTarget');
```

### Retry policy: custom implementation

Replace `RetryPipeline` to change retry counts, delays or the total time one flush may take. Reuse `isRetryableLokiError` and `retryAfterMs` so your policy agrees with `send()`: after the retries, `send()` still calls `isRetryableLokiError` to choose between requeue and drop.

This policy caps `Retry-After` at 30 s, retries up to 8 times and bounds a whole flush to 60 s. The outer timeout rejects with `TimeoutRejectedException`, which has no HTTP response, so `send()` requeues the batch.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { BackoffType, ResiliencePipelineBuilder, TimeSpan } from '@spinajs/util';
import { GraphanaLokiLogTarget, isRetryableLokiError, retryAfterMs } from '@spinajs/log-source-graphana-loki';

const MAX_RETRY_AFTER_MS = 30_000;

@PerInstanceCheck()
@Injectable('PatientLokiTarget')
export class PatientLokiTarget extends GraphanaLokiLogTarget {
  public resolve(): void {
    super.resolve();

    this.RetryPipeline = new ResiliencePipelineBuilder<void>()
      .addTimeout(TimeSpan.fromSeconds(60))
      .addRetry({
        MaxRetryAttempts: 8,
        Delay: TimeSpan.fromMilliseconds(500),
        MaxDelay: TimeSpan.fromSeconds(10),
        BackoffType: BackoffType.Exponential,
        UseJitter: true,
        ShouldHandle: (outcome) => outcome.Error !== undefined && isRetryableLokiError(outcome.Error),
        DelayGenerator: ({ Outcome }) => {
          const ms = retryAfterMs(Outcome.Error);
          return ms === undefined ? undefined : TimeSpan.fromMilliseconds(Math.min(ms, MAX_RETRY_AFTER_MS));
        },
      })
      .build();
  }
}
```

Use it with `{ name: 'Loki', type: 'PatientLokiTarget', options: { host: 'http://loki:3100', labels: { app: 'orders-api' } } }`.

### Payload: custom implementation

Override `send()` to change what leaves the process. This subclass masks card numbers in the message before the base class renders and pushes the batch. It copies each entry, so other targets that received the same entry object keep the original message.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { ILogEntry } from '@spinajs/log';
import { GraphanaLokiLogTarget } from '@spinajs/log-source-graphana-loki';

const CARD_NUMBER = /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g;

@PerInstanceCheck()
@Injectable('RedactingLokiTarget')
export class RedactingLokiTarget extends GraphanaLokiLogTarget {
  protected send(batch: ILogEntry[]): Promise<void> {
    const redacted = batch.map((entry) => ({
      ...entry,
      Variables: {
        ...entry.Variables,
        message: String(entry.Variables.message ?? '').replace(CARD_NUMBER, '[card]'),
      },
    }));

    return super.send(redacted);
  }
}
```

Keep the `send()` contract: resolve on every outcome. A rejection leaves the timer flush unhandled and makes `forceFlush()` and `dispose()` reject.

### Instance identity: custom implementation

By default two definitions with the same `name` share one instance, whatever their other options. Override `__checkInstance__` when the same name can point at different hosts, eg. in tests that build loggers against several Loki fakes.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { GraphanaLokiLogTarget, IGraphanaOptions } from '@spinajs/log-source-graphana-loki';

@PerInstanceCheck()
@Injectable('HostScopedLokiTarget')
export class HostScopedLokiTarget extends GraphanaLokiLogTarget {
  public __checkInstance__(creationOptions: IGraphanaOptions[]): boolean {
    const wanted = creationOptions[0];
    const wantedHost = (wanted as { options?: Partial<IGraphanaOptions> }).options?.host ?? wanted.host;

    return this.Options.name === wanted.name && this.Options.host === wantedHost;
  }
}
```

`creationOptions` is the raw definition passed to `DI.resolve()`, before the constructor flattens `options`; read both places.

## Important behaviour

- Call `super.resolve()` before touching `AxiosInstance`, `RetryPipeline` or `Queue`; they do not exist before it.
- `super.resolve()` starts the flush timer. Validate options before calling it, as the tenant example does; a throw after it leaves a timer running (`unref()`'d, so it does not keep the process alive).
- A subclass registered under its own name has its own DI cache entry, so `GraphanaLogTarget` and `TenantLokiTarget` definitions never share an instance.
- `DI.register(Sub).as("GraphanaLogTarget")` affects only resolves after it. Targets already built by a logger keep the old class.
- `Log` is a getter defined by `@Logger("LogLokiTarget")`; a subclass cannot reassign it.
- `IGraphanaOptions` is the options type of the generic base; extra keys need a cast or an extended interface, as in the tenant example.

## Best practices

- Register a subclass under its own type name first; switch `GraphanaLogTarget` over only when every config must change at once.
- Build on `super.send()` and `super.resolve()` instead of copying their code; the retry, requeue and drop-hook rules stay in one place.
- Keep the `ShouldHandle` of a custom pipeline aligned with `isRetryableLokiError`. A status you retry but `isRetryableLokiError` rejects is dropped after the retries, not requeued.

## Patterns and antipatterns

```ts
// Don't: mutate the shared entry; every other target receives the redacted text too
protected send(batch: ILogEntry[]) {
  batch.forEach((e) => (e.Variables.message = '[redacted]'));
  return super.send(batch);
}

// Do: copy the entry before changing it
protected send(batch: ILogEntry[]) {
  return super.send(batch.map((e) => ({ ...e, Variables: { ...e.Variables, message: '[redacted]' } })));
}
```

```ts
// Don't: replace the pipeline before super.resolve(); the base overwrites it
public resolve() {
  this.RetryPipeline = myPipeline;
  super.resolve();
}

// Do
public resolve() {
  super.resolve();
  this.RetryPipeline = myPipeline;
}
```

## Related

- [Loki target](01-loki-target.md): configuration of the base class.
- [Delivery, retry and buffering](02-delivery-and-retry.md): the default retry policy and drop rules you build on.
- [DI lifetimes](../di/04-lifetimes.md#iinstancecheck-one-instance-per-option-set): `@PerInstanceCheck()` and `IInstanceCheck`.
- [Registering services](../di/01-registering-services.md): which registration wins.
- [`@spinajs/log`](../log/README.md): the `LogTarget` contract and writing a target from scratch.
