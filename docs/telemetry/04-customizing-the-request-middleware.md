# Customizing the request middleware

Subclass `TelemetryMiddleware` to change how requests are labelled or which requests are measured, then remove the shipped registration so only your subclass runs. For a different prefix or different buckets, use configuration instead; see [HTTP request metrics](03-http-request-metrics.md#configuration).

## How it works

1. `TelemetryMiddleware` registers itself with `@Injectable(ServerMiddleware)` when `@spinajs/telemetry` is imported.
2. Your subclass carries its own `@Injectable(ServerMiddleware)`. That **appends** a second entry to the `ServerMiddleware` list; it does not displace the base class.
3. `DI.unregister(TelemetryMiddleware)` removes the base class from every registry list. It matches by type name, so your subclass stays.
4. `HttpServer` resolves the list once, when it is resolved, and mounts each middleware's hooks in `Order`.

Both steps must happen after both modules are imported (decorators register at import time) and before `HttpServer` is resolved.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Request middleware | `ServerMiddleware` list; new instance per resolve; `Order = 2` | `TelemetryMiddleware` | your subclass | Subclass, decorate with `@Injectable(ServerMiddleware)`, then `DI.unregister(TelemetryMiddleware)` before `HttpServer` resolves |

### Overridable members

| Member | Default | Override to |
| --- | --- | --- |
| `routeLabel(ctx)` | mounted path of the matched route (`ctx.path`), else the raw path | collapse unmatched paths, strip versions, group routes |
| `record(ctx)` | records the metrics and calls `Store.record()` for a finished, not aborted request | add a metric, skip some responses; call `super.record(ctx)` |
| `onBefore(ctx)` | starts the clock and the in-flight gauge | skip requests entirely: return without calling `super.onBefore(ctx)`; `onFinish` then leaves the request alone |
| `ensureMetrics()` | defines the three series once per instance | define extra series; call `super.ensureMetrics()` first |
| `Prefix` (field) | `DEFAULT_PREFIX` (`'http'`) | a value other than `'http'` wins over `telemetry.prefix` |
| `Order` (field) | `2` | move the middleware in the stack |

Protected state a subclass can use: `Store` (`TelemetryStore`), `metrics` (`Metrics`), `requestsTotal`, `requestDuration`, `inFlight`, `Buckets`, `ConfiguredPrefix`, `Log`.

### `TelemetryMiddleware`: collapse unmatched paths into one series

The route label falls back to the raw path when no route matched (`ctx.path` is unset). A bot that scans 10 000 URLs then creates 10 000 histogram series. This subclass labels every unmatched request `__unmatched__`.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';
import { TelemetryMiddleware } from '@spinajs/telemetry';

@Injectable(ServerMiddleware)
export class BoundedTelemetry extends TelemetryMiddleware {
  protected routeLabel(ctx: IMiddlewareContext): string {
    return ctx.path ? super.routeLabel(ctx) : '__unmatched__';
  }
}

// Required: without it both middlewares run and every request is counted twice.
DI.unregister(TelemetryMiddleware);
```

The JSON per-route view is already capped by `telemetry.routes.maxEntries`; this override bounds the Prometheus side too.

### `TelemetryMiddleware`: leave probe traffic out

Kubelet probes hit `/telemetry/health` every few seconds and pull the average latency down. Skip `super.onBefore()` for them: a request `onBefore` did not start is neither timed nor counted.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';
import { TelemetryMiddleware } from '@spinajs/telemetry';

const PROBES = new Set(['/telemetry/health', '/telemetry/ready']);

@Injectable(ServerMiddleware)
export class ProbeFreeTelemetry extends TelemetryMiddleware {
  public onBefore(ctx: IMiddlewareContext): void {
    if (PROBES.has(ctx.req.path)) return;
    super.onBefore(ctx);
  }
}

DI.unregister(TelemetryMiddleware);
```

## Important behaviour

- Without `DI.unregister(TelemetryMiddleware)` both middlewares run:
  - both write to the singleton `TelemetryStore`, so `/telemetry/stats`, `/timeline` and `/routes` report double counts;
  - both call `defineMetrics()` with the same prefix, which removes and recreates the series. One instance keeps references to deregistered metric objects, so which `routeLabel()` reaches the rendered histogram depends on middleware order.
- `DI.unregister()` does not touch the cache. Run it before `HttpServer` is resolved; a middleware list already mounted keeps running.
- A `Prefix` other than `'http'` in a subclass wins over `telemetry.prefix`. Set it only in a subclass that replaces the base registration.
- The base class guards its own code: a failing metric or store logs a `warn` and never breaks the request. A throw out of an overridden `record()` is caught and logged the same way; guard additions to `onBefore` yourself.

## Best practices

- Keep `super.record(ctx)` in an override, or the store and the series stop updating. The in-flight gauge is balanced in `onFinish`, whatever `record()` does.
- Return a fixed vocabulary from `routeLabel()`; the same label also keys the per-route JSON view.
- Put the subclass and the `DI.unregister()` call in one module and import it from your app entry, so the order of the two steps is fixed.

## Patterns and antipatterns

```ts
// Don't: a label per tenant or user; one series per value, without a cap
protected routeLabel(ctx: IMiddlewareContext): string {
  return `${ctx.req.headers['x-tenant']}:${super.routeLabel(ctx)}`;
}

// Do: a bounded label, and per-tenant numbers in a dedicated metric with a known tenant list
protected routeLabel(ctx: IMiddlewareContext): string {
  return super.routeLabel(ctx);
}
```

## Examples

### Count throttled responses per route

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import type { IFinishContext } from '@spinajs/http';
import { TelemetryMiddleware } from '@spinajs/telemetry';
import type { Counter } from '@spinajs/telemetry';

@Injectable(ServerMiddleware)
export class ThrottleAwareTelemetry extends TelemetryMiddleware {
  protected throttled?: Counter<string>;

  protected ensureMetrics(): void {
    super.ensureMetrics();
    this.throttled ??= this.metrics.defineMetrics('http', [{ name: 'throttled_total', help: 'Responses answered 429', type: 'counter', labelNames: ['route'] }])['throttled_total'] as Counter<string>;
  }

  protected record(ctx: IFinishContext): void {
    super.record(ctx);
    try {
      if (ctx.res.statusCode === 429) this.throttled?.inc({ route: this.routeLabel(ctx) });
    } catch (err) {
      this.Log?.warn(err as Error, 'throttle counter failed');
    }
  }
}

DI.unregister(TelemetryMiddleware);
```

## Related

- [HTTP request metrics](03-http-request-metrics.md): the default behaviour you extend.
- [`@spinajs/http` server middlewares](../http/15-server-middlewares.md): the `ServerMiddleware` contract and `Order`.
- [`@spinajs/di` registering services](../di/01-registering-services.md#checking-and-removing-registrations): `DI.unregister()`.
