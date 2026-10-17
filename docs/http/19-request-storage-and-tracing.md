# Request storage and tracing

Every request carries `req.storage`, a per-request object that the server middlewares fill: request id, W3C trace ids, client address, timings and perf counters. While the action runs, the same object is the store of a DI-singleton `AsyncLocalStorage`, so services deep in the call stack read it without a `req` parameter, and `@spinajs/log` merges its ids into every log line. Packages extend it with their own fields through TypeScript declaration merging.

## How it works

Per request, the server middlewares fill `req.storage` in `Order`:

1. `RequestStorage` (Order -2) sets `req.storage = {}`.
2. `RequestId` (Order 1) sets `requestId` (UUID v4) and the `x-request-id` response header. It continues the inbound `traceparent` header, or starts a new trace, sets `traceId` and `spanId`, and the outbound `traceparent` response header.
3. `RealIp` (Order 1) sets `realIp`; see [Client IP](17-client-ip-and-trust-proxy.md).
4. `ResponseTime` (Order 2) sets `responseStart`; a patched `res.end` sets `responseEnd`, `responseTime` (ms) and the `x-response-time` header.
5. `ServerTiming` (Order 2) creates `serverTiming = []`; a patched `res.end` appends `total` and writes the `Server-Timing` header from all entries.
6. `AccessLog` (Order 2) logs one line on `res.on('finish')`.
7. `SlowRequestWarning` (Order 2) warns on `finish` when the request took `thresholdMs` or longer.
8. `PerfRollup` (Order 2) creates `perf = { requestId, byName: {} }` and flushes it to the `Perf` sinks of `@spinajs/log` on `finish`, labelled with method, route path and status.

Then the action handler runs argument extraction and the action inside `AsyncLocalStorage.run(req.storage, ...)`. Code called from there reads the same object with `DI.resolve(AsyncLocalStorage).getStore()`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.accessLog.enabled` | `boolean` | `true` | | `AccessLog` on or off. Lines go to the `http.access` logger. |
| `http.serverTiming.enabled` | `boolean` | `true` | | `Server-Timing` header on or off. |
| `http.slowRequest.enabled` | `boolean` | `true` | | Slow-request warnings on or off (`http` logger). |
| `http.slowRequest.thresholdMs` | `number` | `1000` | ms | Requests at or above it are logged at `warn`. |
| `http.perf.enabled` | `boolean` | `true` | | Per-request perf rollup on or off. |

```ts
export default {
  http: {
    accessLog: { enabled: true },
    // Server-Timing exposes internal durations to any client; switch it off on public APIs.
    serverTiming: { enabled: false },
    slowRequest: { enabled: true, thresholdMs: 500 },
    perf: { enabled: true },
  },
};
```

### `req.storage` fields

| Field | Set by | Meaning |
| --- | --- | --- |
| `requestId` | `RequestId` | Correlation id; also `x-request-id` and `@RequestId()`. |
| `traceId`, `spanId` | `RequestId` | W3C trace context, merged into log lines. |
| `realIp` | `RealIp` | Client address; also `@Ip()`. |
| `proxyTrust` | `RealIp` | The parsed proxy trust `realIp` came from; read it with `requestProxyTrust(req)`. |
| `responseStart`, `responseEnd`, `responseTime` | `ResponseTime` | Timing; `responseEnd` and `responseTime` exist only after the answer. |
| `serverTiming` | `ServerTiming` | `IServerTimingEntry[]`: `{ name, dur?, desc? }`; push your own. |
| `perf` | `PerfRollup` | `IPerfScope` accumulator filled by the `Perf` facade. |

The access log line carries `method`, `path` (query values redacted), `status`, `ms`, `ip`, `requestId` and `userAgent`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `IActionLocalStoregeContext` | interface of `req.storage` | the fields above | `language` (`@spinajs/intl-http`), authz principal and decision fields (`@spinajs/authz-http`) | Add fields with `declare module '@spinajs/http' { interface IActionLocalStoregeContext { ... } }` and fill them from a server middleware with Order above -2. |
| `AsyncLocalStorage` | Class `AsyncLocalStorage` from `node:async_hooks`, DI singleton (unregistered, resolves to itself) | one instance shared by `@spinajs/http` and `@spinajs/log` | | Do not replace; read it with `DI.resolve(AsyncLocalStorage)`. |
| `AccessLog`, `ServerTiming`, `SlowRequestWarning`, `PerfRollup` | `ServerMiddleware` list, Order 2 | themselves | | `DI.register(Mine).as(AccessLog)` and so on; see [Server middlewares](15-server-middlewares.md#replacing-a-shipped-middleware). |
| `RequestStorage`, `RequestId`, `ResponseTime` | `ServerMiddleware` list | themselves | | Not exported; not replaceable by class. |

### `IActionLocalStoregeContext`: custom fields

Carry the tenant of each request in the storage, so repositories pick it up without a `req` parameter:

```ts sample
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI, Injectable } from '@spinajs/di';
import { IActionLocalStoregeContext, Request, ServerMiddleware } from '@spinajs/http';
import * as express from 'express';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    tenant?: string;
  }
}

/** Order 1.5: after RequestStorage (-2), RequestId and RealIp (1). */
@Injectable(ServerMiddleware)
export class TenantFromHost extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1.5;
  }

  public before() {
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      // acme.app.example.com → acme
      req.storage.tenant = req.hostname.split('.')[0];
      next();
    };
  }

  public after() {
    return null;
  }
}

/** Any service called from an action. */
export class InvoiceRepository {
  public tableFor(): string {
    const storage = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<IActionLocalStoregeContext>).getStore();
    if (!storage?.tenant) {
      throw new Error('no tenant in this context');
    }
    return `${storage.tenant}_invoices`;
  }
}
```

## Important behaviour

- `AsyncLocalStorage.run()` wraps argument extraction and the action. Policies, `onBefore` route middlewares and server middlewares run outside it: read `req.storage` there.
- `x-request-id`, `traceparent`, `x-response-time` and `Server-Timing` are written in `before()` or by patching `res.end`, because `after()` handlers never run for matched routes.
- An inbound `traceparent` is continued, so a client can choose the trace id of its request.
- `Server-Timing` is on by default and reveals internal timings to every client.
- The access log redacts query values (`/a?token=x` → `/a?token=[redacted]`); paths are logged as they are. Keep secrets out of paths.
- Every request gets a new `requestId`; an inbound `x-request-id` is not reused.

## Best practices

- Use `@RequestId()` in error bodies or support pages so users can quote it; the same id is on the access log line.
- Push phase timings to `req.storage.serverTiming` in development builds only, or switch `ServerTiming` off in production.
- Put request-scoped data on `req.storage` with a typed `declare module` augmentation instead of `any` casts.

## Patterns and antipatterns

```ts
// Don't: module-level variables for request data leak between concurrent requests.
let currentTenant: string;

// Do: put it on req.storage and read it through AsyncLocalStorage.
req.storage.tenant = tenant;
```

## Examples

### Add a database phase to `Server-Timing`

```ts sample
import { BaseController, BasePath, Get, Ok, Req, Request } from '@spinajs/http';

@BasePath('dashboard')
export class DashboardController extends BaseController {
  @Get('/')
  public async index(@Req() req: Request) {
    const started = Date.now();
    const widgets = await Promise.resolve(['sales', 'traffic']);

    // Server-Timing: db;dur=3;desc="widgets", total;dur=5
    req.storage.serverTiming?.push({ name: 'db', dur: Date.now() - started, desc: 'widgets' });

    return new Ok({ widgets });
  }
}
```

## Related

- [Server middlewares](15-server-middlewares.md): the `Order` table.
- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): `realIp`.
- [Route arguments](04-route-arguments.md): `@RequestId()`, `@Ip()`.
- [`@spinajs/log`](../log/README.md): trace context, ambient log context and `Perf`.
