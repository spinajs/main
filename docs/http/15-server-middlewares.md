# Server middlewares

A `ServerMiddleware` adds Express handlers to the whole server: one that runs before routing (`before()`), one that runs after it (`after()`), or both. Its `Order` places it in the stack. The package ships the request storage, CORS, compression, request id, client IP, timing, logging, throttling, 404 and error handlers as server middlewares; other packages add authentication, language and telemetry the same way.

## How it works

1. `HttpServer` autoinjects every class registered with `@Injectable(ServerMiddleware)` when it resolves.
2. `HttpServer.resolve()` sorts them by `Order`, ascending, and adds each non-null `before()` handler in that order, after the raw `http.middlewares`.
3. `HttpServer.start()` adds each non-null `after()` handler once, in **descending** `Order`, after the controllers router. The lowest `Order` ends up last in the Express stack.
4. `before()` and `after()` are called once, at those moments. They return the Express handler; per-request code lives inside it.

`after()` handlers only run for requests that no route answered, or that failed with an error: a matched route sends its answer inside the controllers router without calling `next()`. Code that must touch every response (a header, a log line) patches `res.end` or listens to `res.on('finish')` in `before()`.

### Shipped middlewares

| Class | `Order` | Exported | Hook | Configuration | Effect |
| --- | --- | --- | --- | --- | --- |
| `RequestStorage` | -2 | no | before | | Creates `req.storage = {}`. |
| `CorsMiddleware` | -1 | yes | before | `http.cors` | CORS headers and preflight; see [CORS](16-cors.md). |
| `Compression` | 0 | yes | before | `http.compression.*` | gzip/brotli via `compression`. |
| `RequestId` | 1 | no | before | | `req.storage.requestId`, `x-request-id` and `traceparent` headers. |
| `RealIp` | 1 | yes | before | `http.trustProxy` | `req.storage.realIp`; see [Client IP](17-client-ip-and-trust-proxy.md). |
| `ResponseTime` | 2 | no | before | | `x-response-time` header, `req.storage.responseTime`. |
| `AccessLog` | 2 | yes | before | `http.accessLog.enabled` | One log line per request on `http.access`. |
| `ServerTiming` | 2 | yes | before | `http.serverTiming.enabled` | `Server-Timing` header. |
| `SlowRequestWarning` | 2 | yes | before | `http.slowRequest.*` | Warns about slow requests. |
| `PerfRollup` | 2 | yes | before | `http.perf.enabled` | Per-request perf rollup. |
| `ThrottleMiddleware` | 3 | yes | before | `http.throttle.*` | Rate limits; see [Throttling](18-throttling.md). |
| `NotFoundMiddleware` | `Number.MIN_SAFE_INTEGER` | yes | after | | `ResourceNotFound` for unmatched routes. |
| `ErrorHandlerMiddleware` | `Number.MIN_SAFE_INTEGER - 1` | yes | after | | The final [error handler](11-error-handling.md). |

The request storage, request id and timing middlewares are on [Request storage and tracing](19-request-storage-and-tracing.md). Middlewares with the same `Order` run in registration order.

Middlewares from other packages, for orientation: `ClientIp`, `CsrfOriginGuard`, `AuthnMiddleware` (`@spinajs/authn-http`), `PrincipalMiddleware`, `AccessEpochMiddleware` (`@spinajs/authz-http`), `IntHttpMiddleware` (`@spinajs/intl-http`), `TelemetryMiddleware` (`@spinajs/telemetry`).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.middlewares` | `express.RequestHandler[]` | see [HTTP server](01-http-server.md#configuration) | | Raw Express handlers, added before every server middleware. |
| `http.compression.enabled` | `boolean` | `true` | | `false`: `Compression` adds no handler. |
| `http.compression.threshold` | `number` | `1024` | bytes | Smaller bodies are not compressed. |
| `http.compression.level` | `number` | `-1` | zlib levels `-1` to `9` | Compression level; `-1` is the zlib default. |

The other keys are on the pages of each middleware.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ServerMiddleware` (abstract, an `AsyncService`) | `ServerMiddleware` list, autoinjected into `HttpServer`; each a singleton | the table above | the classes from other packages listed above | Add one with `@Injectable(ServerMiddleware)`, imported before `HttpServer` resolves. Replace one with `DI.register(Mine).as(Theirs)` (eg. `.as(AccessLog)`). Remove one with `DI.unregister(Theirs)` before `HttpServer` resolves, or switch it off in configuration. |

Members:

| Member | Meaning |
| --- | --- |
| `Order: number` | Set in the constructor. Lower runs earlier in `before()` and later in `after()`. |
| `before()` | Returns `(req, res, next) => void` or `null`. |
| `after()` | Returns a 3-argument handler, a 4-argument error handler `(err, req, res, next)`, or `null`. |
| `resolve()` | `AsyncService` hook, runs before `before()` is called; read configuration here. |

Choose `Order` by what you need: above -2 for `req.storage`, above 1 for `req.storage.requestId` and `realIp`, below -1 to answer before CORS.

### `ServerMiddleware`: custom implementation

Refuse requests during a maintenance window, except health checks. It needs nothing from `req.storage`, so it runs right after CORS (Order -1) and before compression:

```ts sample
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Request, ServerMiddleware } from '@spinajs/http';
import * as express from 'express';

@Injectable(ServerMiddleware)
export class MaintenanceMode extends ServerMiddleware {
  @Config('app.maintenance.enabled', { defaultValue: false })
  protected Enabled: boolean;

  @Config('app.maintenance.retryAfterSeconds', { defaultValue: 600 })
  protected RetryAfter: number;

  constructor() {
    super();
    this.Order = -0.5;
  }

  public before() {
    if (!this.Enabled) {
      return null;
    }

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      if (req.path === '/health') {
        return next();
      }
      res.setHeader('Retry-After', String(this.RetryAfter));
      res.status(503).json({ error: { code: 'E_MAINTENANCE', message: 'down for maintenance' } });
    };
  }

  public after() {
    return null;
  }
}
```

### Replacing a shipped middleware

Subclass it and register the subclass under the shipped class; the `ServerMiddleware` list then yields your class in its place. Register before `HttpServer` resolves.

```ts sample
import { DI } from '@spinajs/di';
import { AccessLog, Request } from '@spinajs/http';
import * as express from 'express';

/** Same access log, but health checks and static assets are not logged. */
export class QuietAccessLog extends AccessLog {
  public before() {
    const inner = super.before();
    if (!inner) {
      return null;
    }

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      if (req.path === '/health' || req.path.startsWith('/_static/')) {
        return next();
      }
      inner(req, res, next);
    };
  }
}

DI.register(QuietAccessLog).as(AccessLog);
```

## Important behaviour

- The list is read when `HttpServer` resolves. A middleware module imported later never runs.
- `after()` does not run for matched routes. `RequestId`, `ResponseTime` and `ServerTiming` set their headers in `before()` for that reason.
- `before()` runs once at startup. Configuration read there is fixed for the life of the server.
- `Compression` is on by default and the default `http.middlewares` also contain `compression()`. The second one skips bodies that are already encoded.
- `Array.ofType` drops `@NewInstance()` registrations: a server middleware decorated `@NewInstance()` never runs.
- `RequestStorage`, `RequestId` and `ResponseTime` are not exported from the package entry and have no configuration switch. `@RequestId()`, `@Ip()`, the access log and every middleware that reads `req.storage` depend on them.

## Best practices

- Return `null` from `before()` when the middleware is switched off in configuration; nothing is added to the stack.
- Read `req.storage` only from an `Order` above -2.
- Answer early (status and `res.end()`) without calling `next()`; call `next(err)` to hand an error to the error handler.

## Patterns and antipatterns

```ts
// Don't: set a response header in after(); matched routes never reach it.
public after() {
  return (_req: Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('x-app-version', '3.1.0');
    next();
  };
}

// Do: set it in before(), while the response is still open.
public before() {
  return (_req: Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('x-app-version', '3.1.0');
    next();
  };
}
```

## Examples

### Add a security header to every response

```ts sample
import { Injectable } from '@spinajs/di';
import { Request, ServerMiddleware } from '@spinajs/http';
import * as express from 'express';

@Injectable(ServerMiddleware)
export class PermissionsPolicyHeader extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public before() {
    return (_req: Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      next();
    };
  }

  public after() {
    return null;
  }
}
```

## Related

- [HTTP server](01-http-server.md): when `before()` and `after()` are attached.
- [Request storage and tracing](19-request-storage-and-tracing.md), [CORS](16-cors.md), [Client IP](17-client-ip-and-trust-proxy.md), [Throttling](18-throttling.md): the shipped middlewares in detail.
- [Route middlewares](14-route-middlewares.md): code around specific routes.
- [Error handling](11-error-handling.md): `NotFoundMiddleware` and `ErrorHandlerMiddleware`.
