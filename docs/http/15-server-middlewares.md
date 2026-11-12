# Server middlewares

A `ServerMiddleware` runs for every request the server gets before routing; static files are one of them, `StaticFiles` at `http.static.order` (4.5). It has the same hooks as a [route middleware](14-route-middlewares.md): `onBefore`, `onAfter`, `onFinish` and `onAround`, with the same context objects, plus an `Order` that places it among the other server middlewares. The package ships CORS, compression, request id, client IP, timing, logging, throttling, the body and cookie parsers, body limits and the CSRF guard as server middlewares; other packages add authentication, language and telemetry the same way.

## How it works

1. `HttpServer` autoinjects every class registered with `@Injectable(ServerMiddleware)` when it resolves, and sorts them by `Order`, ascending. Equal `Order`s keep the DI registration order: the order the classes were registered under `ServerMiddleware` (for `@Injectable`, the order their modules were imported), however long each one's `resolve()` takes.
2. For each one it calls `isEnabled()` once: `false` mounts nothing. Settings are parsed and validated there or in `resolve()`, never per request.
3. It mounts `handler()` when the middleware has one (a third-party Express handler, such as `compression`); otherwise the `onAround` handler, then the `onBefore` handler.
4. `HttpServer.start()` mounts, after the controllers' routers, the 404 and the global error answer (see [NotFound and the global error answer](#notfound-and-the-global-error-answer)).

### Request timeline

```
req.storage = {}                        HttpServer's first handler, before everything else
http.middlewares                        raw Express handlers: helmet
server middlewares, Order <= 4.5        handler(), or onAround and onBefore; cookie parser 0.5, body limits 3.4, body parsers 3.5, CSRF 4
static files (http.static.order 4.5)    not a framework reply: onFinish only, no onAfter; skips the later middlewares
server middlewares, Order > 4.5         authentication 5, principal 10, ...
routing                                 policy gate, route middlewares, action, error handlers
404 / global error answer               fixed tail of HttpServer
reply pipeline                          route onAfter (inner first), then server onAfter (descending), then the reply is sent
onFinish                                route ones, then server ones, once the response finished or the client went away
```

Every framework reply goes through the reply pipeline: the action's `Response`, an error reply, the 404, and a `Response` an `onBefore` returned (a CORS preflight, a 429, a CSRF refusal). Server `onAfter` hooks see each of them, after the route's.

### Entered middlewares

Only a middleware the chain entered gets `onAfter` and `onFinish`: its `onBefore` completed, or its `onAround` started, or its `handler()` was called, or it has none of these and the chain reached it. A middleware after the one that answered, or after one that threw, is not entered. `onAfter` and `onFinish` run in the exact reverse of the order the middlewares were entered in: descending `Order`, ties in reverse registration order.

### Hooks

| Hook | When | Context |
| --- | --- | --- |
| `onBefore(ctx)` | Before routing, and before static files when `Order` is below `http.static.order`. Returning a `Response` answers the request: no later middleware, no route; the reply goes through the pipeline. A throw is answered by the global error answer. May return synchronously; the chain then goes on in the same tick. | `IMiddlewareContext`: `req`, `res`, `storage`; `route`, `controller` and `path` of the route the request will match (see [The route before routing](#the-route-before-routing)) |
| `onAround(ctx, proceed)` | Wraps everything after it. `proceed()` resolves `{ reply, error }` once the response finished; `error` is the error the reply answers (a route error, a 404). It rejects with `RouteClientGone` when the client went away first. | `IMiddlewareContext`, with the route matched before routing |
| `onAfter(ctx)` | For every framework reply, before it is sent, after the route's `onAfter`. May set headers, replace `ctx.response` or its data. May return synchronously. A throw turns the reply into an error reply for that error: when a route matched, the route's (its `@OnError` handlers at the `'after'` stage, `http.errors.handlers`, the error map), else the global error answer's (`ErrorHandlerMiddleware.reply`). | `IReplyContext`: `response`, `error`; `route`, `controller` and `path` when a route matched |
| `onFinish(ctx)` | Once, when the response finished or the client went away (`aborted`, also for a streamed reply the client closed after the headers were sent: `ctx.res.headersSent` tells them apart). Not awaited by the next one. A throw is logged. | `IFinishContext`: `aborted`; `route`, `controller`, `path` when a route matched |
| `handler()` | Called once at mount. An Express handler mounted at `Order` in place of `onBefore`/`onAround`. | |

### Shipped middlewares

| Class | `Order` | Exported | Hooks | Configuration | Effect |
| --- | --- | --- | --- | --- | --- |
| `CorsMiddleware` | -1 | yes | onBefore, onAfter | `http.cors`, `@Cors` | CORS headers; answers an allowed preflight 204; `onAfter` applies a `@Cors` route policy to framework replies. See [CORS](16-cors.md). |
| `RequestDeadline` | -0.3 | yes | onBefore, onFinish | `http.deadline.*` | `req.storage.signal` and `deadline`; 504 when nothing was sent by the deadline; see [Request deadlines](29-request-deadlines.md). |
| `Compression` | 0 | yes | handler | `http.compression.*` | gzip/brotli via `compression`. |
| `RequestId` | 1 | as `RequestIdMiddleware` | onBefore | | `req.storage.requestId`, `x-request-id` and `traceparent` headers. |
| `RealIp` | 1 | yes | onBefore | `http.trustProxy` | `req.storage.realIp`; see [Client IP](17-client-ip-and-trust-proxy.md). `@spinajs/authn-http` replaces it with `AuthnRealIp`. |
| `ResponseTime` | 2 | yes | onBefore, onAfter | | `x-response-time` header, `req.storage.responseTime`. |
| `AccessLog` | 2 | yes | onBefore, onFinish | `http.accessLog.enabled` | One log line per request on `http.access`, aborted ones included: a streamed reply the client closed is logged with its status and `aborted: true`. |
| `ServerTiming` | 2 | yes | onBefore, onAfter | `http.serverTiming.enabled` | `Server-Timing` header. |
| `SlowRequestWarning` | 2 | yes | onBefore, onFinish | `http.slowRequest.*` | Warns about slow requests; ignores aborted ones. |
| `PerfRollup` | 2 | yes | onBefore, onFinish | `http.perf.enabled` | Per-request perf rollup. |
| `CookieParserMiddleware` | 0.5 | yes | handler | `http.bodyParsers.cookies`, `http.cookie.secret` | `req.cookies`, `req.signedCookies`; see [Body and cookie parsers](01-http-server.md#body-and-cookie-parsers). |
| `MaintenanceMode` | 2.5 | yes | onBefore | `http.maintenance.*` | 503 during maintenance (but allowed paths) and, with `Connection: close`, while the server is closing; see [Maintenance mode](27-maintenance-mode.md). Always mounted. |
| `ConcurrencyLimit` | 2.6 | yes | onBefore, onFinish | `http.concurrency.*` | Load shedding: 503 with `Retry-After` over `max` requests in flight; see [Concurrency limit](28-concurrency-limit.md). |
| `ThrottleMiddleware` | 3 | yes | onBefore | `http.throttle.*` | Rate limits; see [Throttling](18-throttling.md). |
| `BodyLimits` | 3.4 | yes | handler | `http.bodyLimits` | Per-path body limits; see [Body size limits](04-route-arguments.md#body-size-limits). |
| `JsonBodyParser`, `UrlencodedBodyParser`, `TextBodyParser` | 3.5 | yes | handler | `http.bodyParsers.{json,urlencoded,text}` | `req.body`, `req.rawBody` for JSON. |
| `CsrfGuard` | 4 | yes | onBefore | `http.csrf.*` | Refuses cross-origin unsafe browser requests; see [CSRF guard](23-csrf-guard.md). Off when a subclass such as `CsrfOriginGuard` is registered. |
| `RequestStorage` | -2 | yes | | | Deprecated and not registered: `HttpServer` creates `req.storage` itself. Removed in the next major. |

The request id and timing middlewares are on [Request storage and tracing](19-request-storage-and-tracing.md).

Middlewares from other packages, for orientation: `ClientIp`, `CsrfOriginGuard`, `AuthnMiddleware` (`@spinajs/authn-http`), `PrincipalMiddleware`, `AccessEpochMiddleware` (`@spinajs/authz-http`), `IntlHttpMiddleware` (`@spinajs/intl-http`), `TelemetryMiddleware` (`@spinajs/telemetry`).

### NotFound and the global error answer

They are not server middlewares: `HttpServer` mounts them last, after routing, and both replies go through the reply pipeline, so the entered server middlewares' `onAfter` see them.

- `NotFoundMiddleware.reply(req)` answers a request nothing else answered. By default it returns `ResourceNotFound`, which the global error answer turns into a 404. A returned `Response` is sent as it is.
- `ErrorHandlerMiddleware.reply(error, req)` makes the reply for an error no route answered: a 404, a throwing server middleware, a malformed body or one over its limit. By default it is the error map's reply, and it logs the error.

Replace either with `DI.register(Mine).as(NotFoundMiddleware)` before `HttpServer` resolves; see [Error handling](11-error-handling.md).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.middlewares` | `express.RequestHandler[]` | see [HTTP server](01-http-server.md#configuration) | | Raw Express handlers, added before every server middleware. |
| `http.compression.enabled` | `boolean` | `true` | | `false`: `Compression` mounts nothing. The default `http.middlewares` hold no compression either; an app that lists `compression()` there itself still compresses. |
| `http.compression.threshold` | `number` | `1024` | bytes | Smaller bodies are not compressed. |
| `http.compression.level` | `number` | `-1` | zlib levels `-1` to `9` | Compression level; `-1` is the zlib default. |

The other keys are on the pages of each middleware.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ServerMiddleware` (abstract, an `AsyncService`) | `ServerMiddleware` list, autoinjected into `HttpServer`; each a singleton | the table above | the classes from other packages listed above | Add one with `@Injectable(ServerMiddleware)`, imported before `HttpServer` resolves. Replace one with `DI.register(Mine).as(Theirs)` (eg. `.as(AccessLog)`). Remove one with `DI.unregister(Theirs)` before `HttpServer` resolves, or switch it off in configuration. |
| `NotFoundMiddleware`, `ErrorHandlerMiddleware` | resolved by class when `HttpServer` resolves, singletons | themselves | | `DI.register(Mine).as(NotFoundMiddleware)`; override `reply()`. |
| `RouteIndex` | resolved by class, singleton; autoinjected into `HttpServer`, `Controllers`, `BaseController`, `CorsMiddleware` and `CsrfGuard` | itself | | Read it with `match(method, path)` or `matchAll(method, path)`; `BaseController.resolve()` adds the routes it mounts, `Controllers` the router it mounts them on. |

Members of `ServerMiddleware`:

| Member | Meaning |
| --- | --- |
| `Order: number` | Set in the constructor. Lower runs earlier; its `onAfter` and `onFinish` run later. |
| `isEnabled(): boolean` | Called once at mount; `true` by default. |
| `handler?(): express.RequestHandler \| null` | A third-party handler mounted in place of `onBefore`/`onAround`. |
| `resolve()` | `AsyncService` hook, awaited before `HttpServer` mounts the middleware; read and validate configuration here. |
| `onBefore`, `onAfter`, `onFinish`, `onAround` | The hooks above. |
| `before()`, `after()` | Removed; see [Migrating from before() and after()](#migrating-from-before-and-after). |

Choose `Order` by what you need: above 1 for `req.storage.requestId` and `realIp`, below -1 to answer before CORS. `req.storage` exists for every `Order`.

### `ServerMiddleware`: custom implementation

Refuse writes during a database migration while reads go on. It runs right after `MaintenanceMode` (Order 2.5), with the request id and the access log in place, and before `ConcurrencyLimit` (2.6), so a refused write takes no slot. Its 503 goes through the reply pipeline, so CORS headers and the `onAfter` of the middlewares entered before it still apply:

```ts sample
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { IMiddlewareContext, Json, Response, ServerMiddleware } from '@spinajs/http';

const SAFE = ['GET', 'HEAD', 'OPTIONS'];

@Injectable(ServerMiddleware)
export class ReadOnlyMode extends ServerMiddleware {
  @Config('app.readOnly.enabled', { defaultValue: false })
  protected Enabled: boolean;

  constructor() {
    super();
    this.Order = 2.55;
  }

  public isEnabled() {
    return this.Enabled;
  }

  public onBefore({ req }: IMiddlewareContext): Response | undefined {
    if (SAFE.includes(req.method)) {
      return undefined;
    }
    return new Json({ error: { code: 'E_READ_ONLY', message: 'writes are paused, try again later' } }, { StatusCode: 503, Headers: [{ Name: 'Retry-After', Value: '120' }] });
  }
}
```

### Replacing a shipped middleware

Subclass it and register the subclass under the shipped class; the `ServerMiddleware` list then yields your class in its place. Register before `HttpServer` resolves. `AccessLog` has `shouldLog(ctx)` for this:

```ts sample
import { DI } from '@spinajs/di';
import { AccessLog, IFinishContext } from '@spinajs/http';

/** Same access log, but health checks and static assets are not logged. */
export class QuietAccessLog extends AccessLog {
  protected shouldLog({ req }: IFinishContext) {
    return req.path !== '/health' && !req.path.startsWith('/_static/');
  }
}

DI.register(QuietAccessLog).as(AccessLog);
```

### Migrating from `before()` and `after()`

`ServerMiddleware` has no `before()` or `after()` in 4.x. A server middleware, or a `NotFoundMiddleware` or `ErrorHandlerMiddleware` replacement, that still defines one fails `HttpServer.resolve()` with an `InvalidOperation` naming the class, rather than being ignored. A subclass of a shipped middleware that wrapped `super.before()` overrides the hook instead and calls `super.onBefore(ctx)`, or overrides the protected decision method the middleware offers (`allowance()`, `shouldLog()`, `refuse()`, `proxyTrust()`).

| 3.x | 4.x |
| --- | --- |
| `before()` returning a handler that calls `next()` | `onBefore(ctx)`; returning nothing goes on |
| `before()` answering with `res.status().json()` | `onBefore(ctx)` returning a `Response` |
| `before()` returning `null` when switched off | `isEnabled()` returning `false` |
| configuration parsed in `before()` | `resolve()` or `isEnabled()` |
| `res.on('finish')` in `before()` | `onFinish(ctx)`, with `aborted` for a client that went away |
| a header set by patching `res.end` | `onAfter(ctx)` |
| `before()` returning a third-party handler | `handler()` |
| `after()` | `onAfter(ctx)` for a reply, or replace `NotFoundMiddleware` / `ErrorHandlerMiddleware` and override `reply()` |

## Important behaviour

- The list is read when `HttpServer` resolves. A middleware module imported later never runs.
- `onBefore` and `onAround` get the route the `RouteIndex` matches before routing, a best-effort match; `onAfter` and `onFinish` get the route the router matched, or the pre-routing match when no route ran (a refusal from an `onBefore`, a 404).
- Static files and replies an action wrote to `res` itself get `onFinish` only, no `onAfter`: `ResponseTime` and `ServerTiming` headers are missing on them.
- A static file is served by `StaticFiles` at `http.static.order` (4.5): server middlewares with a higher `Order` (authentication, `PrincipalMiddleware`, `AccessEpochMiddleware`, your own above 4.5) never see it. `Infinity` puts the static files after every server middleware, as in 3.x.
- `onAfter` runs before the reply is serialised. A header it sets on `res` wins over the `Response`'s own `IResponseOptions.Headers`.
- The body parsers run at Order 3.5, after `BodyLimits` (3.4): a server middleware below 3.5 sees no `req.body`, one below the cookie parser (0.5) no `req.cookies`. A 400 for a malformed body or a 413 goes to the global error answer; the server middlewares entered before the parser (CORS, `RequestId`, `AccessLog`, ...) see it in `onAfter`/`onFinish`, the ones after it are not entered. A parser left in `http.middlewares` by a 3.x app still runs before every server middleware, and a handler there that the package did not ship moves `http.bodyLimits` before the list; see [Body and cookie parsers](01-http-server.md#body-and-cookie-parsers).
- Server hooks run outside the action's AsyncLocalStorage context: read `ctx.storage`.
- `Array.ofType` drops `@NewInstance()` registrations: a server middleware decorated `@NewInstance()` never runs.
- `RequestId` and `ResponseTime` have no configuration switch; the package entry exports them as `RequestIdMiddleware` and `ResponseTime`. `@RequestId()`, `@Ip()` and the access log depend on them.

## The route before routing

Server middlewares run before routing, so `HttpServer` looks the request up in the `RouteIndex`. It walks the controllers router the app serves, in its order, with the router's own matching (params, case, trailing slash, `HEAD` served by `GET`), and knows each route a controller mounted. `ctx.route`, `ctx.controller` and `ctx.path` (`http:<METHOD> <mounted path>`) of a server `onBefore` and `onAround` hold the route the router will serve the request with, looked up when one of them is read; a middleware that rewrites `req.url` or `req.method` changes the answer for those read after it.

It is a best-effort match; the real route is the router's. A static file or an `http.middlewares` handler mounted ahead of the controllers may answer the request instead, and a malformed percent-encoding in a parameter matches nothing. A controller added later with `Controllers.add()` is matched once it is mounted. At boot the index checks that the installed Express router still works the way it reads it, and fails the boot with `InvalidOperation` when it does not. When the server listens with routes the controllers registered but no controllers router mounted in the index (a custom `Controllers` that does not mount it), it logs a warning: every lookup then misses.

`RouteIndex.match(method, path)` gives the route for any method, for example the method a CORS preflight asks about; `matchAll(method, path)` gives every mounted route that could serve it, for a decision that must not depend on which one the router picks:

```ts sample
import { Autoinject } from '@spinajs/di';
import { ServerMiddleware, RouteIndex } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';

export class PreflightLog extends ServerMiddleware {
  @Autoinject(RouteIndex)
  protected Routes!: RouteIndex;

  public onBefore({ req }: IMiddlewareContext) {
    const asked = req.headers['access-control-request-method'];
    if (req.method === 'OPTIONS' && typeof asked === 'string') {
      console.log(this.Routes.match(asked, req.path)?.path ?? 'no route');
    }
  }
}
```

## Best practices

- Return `false` from `isEnabled()` when the middleware is switched off in configuration; nothing is mounted.
- Answer early by returning a `Response` from `onBefore`; throw to hand an error to the global error answer.
- Put headers that must be on every framework reply in `onAfter`; headers that must also reach static files in `onBefore`.

## Patterns and antipatterns

```ts
// Don't: patch res.end to add a header; the reply pipeline already gives you the reply.
public onBefore({ res }: IMiddlewareContext) {
  const end = res.end.bind(res);
  res.end = ((...args: any[]) => (res.setHeader('x-app-version', '3.1.0'), end(...args))) as typeof res.end;
}

// Do: set it in onAfter.
public async onAfter({ res }: IReplyContext) {
  res.setHeader('x-app-version', '3.1.0');
}
```

## Examples

### Add a security header to every response

Set in `onBefore`, so static files get it too:

```ts sample
import { Injectable } from '@spinajs/di';
import { IMiddlewareContext, ServerMiddleware } from '@spinajs/http';

@Injectable(ServerMiddleware)
export class PermissionsPolicyHeader extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public onBefore({ res }: IMiddlewareContext) {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
}
```

### Time every request

```ts sample
import { performance } from 'node:perf_hooks';
import { Injectable } from '@spinajs/di';
import { IMiddlewareContext, IRouteOutcome, RouteClientGone, ServerMiddleware } from '@spinajs/http';

@Injectable(ServerMiddleware)
export class RequestTimer extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -5;
  }

  public async onAround({ req }: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>) {
    const started = performance.now();
    try {
      const { reply, error } = await proceed();
      console.log(req.method, req.originalUrl, reply?.status ?? '-', error ? 'failed' : 'ok', performance.now() - started);
    } catch (err) {
      // the client went away (RouteClientGone): there is no reply to time; rethrown, it would be logged as a failure
      if (!(err instanceof RouteClientGone)) throw err;
    }
  }
}
```

## Related

- [HTTP server](01-http-server.md): when the server middlewares and the tail are attached.
- [Route middlewares](14-route-middlewares.md): the same hooks around specific routes; the reply pipeline.
- [Request storage and tracing](19-request-storage-and-tracing.md), [CORS](16-cors.md), [Client IP](17-client-ip-and-trust-proxy.md), [Throttling](18-throttling.md), [Maintenance mode](27-maintenance-mode.md), [Concurrency limit](28-concurrency-limit.md), [Request deadlines](29-request-deadlines.md): the shipped middlewares in detail.
- [Error handling](11-error-handling.md): `NotFoundMiddleware` and `ErrorHandlerMiddleware`.
