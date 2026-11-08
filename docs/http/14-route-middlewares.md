# Route middlewares

A route middleware runs code around one route, around every route of a controller, or around every route of the app: before the action, on the reply before it is sent, and after the response finished. Use it for cross-cutting work that belongs to specific endpoints, such as audit logging, cache headers or a content-type check. For work on every request of the server, use a [server middleware](15-server-middlewares.md).

## How it works

**At startup**, for each route, `BaseController.resolve()`:

1. Resolves the [global middlewares](#global-route-middlewares), then the controller's, then the route's, with `container.resolve(type, options)`.
2. Keeps those whose `isEnabled(route, controller)` returns `true`. This is decided once, not per request.
3. Calls `onRegister(route, path, controller)` of each kept middleware that has one. A throw fails the registration.
4. Builds the handler chain from the hooks each middleware implements; a middleware with no hook adds nothing to the chain.

**Per request**, the route runs this timeline:

```
onAround / onBefore                 each 'beforePolicy' middleware, in entry order (see below)
policy gate                         refuses the request, or lets it through
onAround / onBefore                 each 'outer' middleware, then each 'inner' one, in entry order
action                              returns a Response, or throws
error handlers                      on a throw: @OnError, http.errors.handlers, the error map
reply pipeline                      once for the reply, whichever produced it:
  onAfter                             each entered middleware, inner (last entered) first
  response.execute()                  serialisation, headers, send
onFinish                            each entered middleware, inner first, once the response finished or the client went away
```

The reply pipeline handles every framework reply of the route: the `Response` the action returned, an error reply (from an `@OnError` handler, an `http.errors.handlers` service or the error map), a `Response` an `onBefore` returned, and a reply an `@Idempotent` route replays. Every `onAfter` sees each of them.

### Entered middlewares

Only a middleware the chain entered gets `onAfter` and `onFinish`, and they run in the exact reverse of the entry order. The entry order is the chain order: `'beforePolicy'`, then `'outer'`, then `'inner'`, and within a stage the [global](#global-route-middlewares) ones in config order, then the controller's, then the route's, the last two in declaration order (decorators apply bottom-up, so the lowest `@Middleware` of a list is entered first). A middleware is entered when the chain reached it and its `onBefore` resolved, or when the chain reached it and it has no `onBefore`. An around middleware is entered when its `onAround` starts.

| Case | Entered |
| --- | --- |
| The policy gate refused the request | the `'beforePolicy'` ones; none after the gate |
| An `onBefore` threw | the middlewares before it; not this one, and none after it |
| An `onBefore` returned a `Response` | the middlewares before it and this one; none after it |
| The action threw | every enabled middleware |

## Hooks

Every hook is optional; a middleware implements only those it needs.

| Hook | Runs | Gets | Can |
| --- | --- | --- | --- |
| `isEnabled(route, controller): boolean` | once per route, at startup | the route and the controller | keep the middleware off this route; `true` unless overridden |
| `onRegister?(route, path, controller)` | once per route, when it is mounted | the route, the mounted path and the controller | check configuration, load an optional dependency; a throw fails the registration |
| `onBefore?(ctx): void \| Response \| Promise<void \| Response>` | before the action, in chain order | `IMiddlewareContext` | change `req`, set headers, throw to refuse, return a `Response` to answer |
| `onAfter?(ctx): void \| Promise<void>` | in the reply pipeline, before the reply is sent | `IReplyContext` | read or change the reply: `ctx.response`, its `data`, the headers on `ctx.res`; read `ctx.error` |
| `onFinish?(ctx): void \| Promise<void>` | once the response finished or the client went away | `IFinishContext` | log, record metrics; a throw is logged on the `http` logger |
| `onAround?(invocation, proceed): Promise<void>` | wraps the rest of the chain | `IRouteInvocation` and `proceed` | see [Around middlewares](#around-middlewares) |

### Contexts

| Type | Members |
| --- | --- |
| `IMiddlewareContext` | `req`, `res`, `storage` (the same object as `req.storage`), and for a route middleware `route`, `controller` and `path` (`http:<METHOD> <mounted path>`) |
| `IReplyContext` | `IMiddlewareContext` plus `response: Response` (the reply about to be sent; a hook may replace it) and `error?: unknown` (the error the reply answers, when it is an error reply) |
| `IFinishContext` | `IMiddlewareContext` plus `aborted: boolean` (`true` when the client went away before the response finished) |
| `IRouteInvocation` | `IMiddlewareContext` with `route`, `controller` and `path` always set |

A route middleware's hooks get the route fields set. The fields are optional on `IMiddlewareContext` because the same base class, `HttpMiddleware`, carries [server middlewares](15-server-middlewares.md), whose `onBefore` and `onAround` run before routing.

### Answering in `onBefore`

An `onBefore` that returns a `Response` answers the request. No later middleware and no action runs. The `Response` goes through the reply pipeline as a success reply, without `ctx.error`: the `onAfter` of every entered middleware, including the one that answered, sees it.

```ts sample
import { BaseController, BasePath, Get, IMiddlewareContext, Middleware, NoContent, Ok, Response, RouteMiddleware } from '@spinajs/http';

/** Answers a probe from the load balancer without running the route. */
export class ProbeShortcut extends RouteMiddleware {
  public async onBefore({ req }: IMiddlewareContext): Promise<void | Response> {
    if (req.headers['x-probe'] === '1') return new NoContent(null);
  }
}

@BasePath('status')
@Middleware(ProbeShortcut)
export class StatusController extends BaseController {
  @Get()
  public index() {
    return new Ok({ up: true });
  }
}
```

### Error replies

`onAfter` runs for error replies too, with `ctx.error` set to the error the reply answers. A middleware that must act on success only returns early when `ctx.error !== undefined`.

### A throwing `onAfter`

A throwing `onAfter` turns the reply into the error reply for its error, as an error of the action would get: the route's `@OnError` handlers see it at the `'after'` stage, then the `http.errors.handlers` services, then the error map. The hooks that already ran do not run again; the remaining ones see the error reply, with `ctx.error`. A further throw while the hooks run on that error reply is logged on the `http` logger and the error reply is sent as it is, so a failing hook never loops.

### AsyncLocalStorage

The action runs inside the AsyncLocalStorage context of `req.storage`, so the services it calls read the request's store. `onAfter` and `onFinish` run inside the same context: a service called from them reads the store the action saw. `onBefore` and `onAround` run outside it; pass `ctx.storage` to a service called from them.

### Replies the framework does not send

When the headers are already sent as the reply pipeline starts, because an action wrote `res` itself (`res.send()`, `res.pipe()`, `res.sendFile()`), no `onAfter` runs: the reply can no longer change. `onFinish` still runs. An action that wrote `res` and returned nothing gets no 404.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Middleware(type, ...options)` | class or method | `type`: a `RouteMiddleware` class; `options`: constructor arguments | Adds the middleware to the controller (class) or the route (method). |
| `@Accepts(types)` | class or method | `HttpAcceptHeaders` flags, eg. `HttpAcceptHeaders.JSON \| HttpAcceptHeaders.HTML` | Adds `AcceptsMiddleware`, which refuses the request with `ExpectedResponseUnacceptable`, answered as `NotAcceptable` (406), when the `Accept` header allows none of `types`. |
| `@RateLimit(limit, windowSeconds, by?)` | class or method | `limit` per `windowSeconds`, counted per client address (`'ip'`, default) or per authenticated principal (`'principal'`) | Adds `RateLimitMiddleware` (`'outer'`), which answers 429 with `Retry-After` over the limit; one counter per route. See [Throttling](18-throttling.md#per-route-limits-ratelimit). |

### `@Accepts`

The `Accept` header is matched with Express's `req.accepts()`, which honours lists, wildcards and `q` values. The value is the OR of the flag of every type the header allows:

| Type allowed by `Accept` | `HttpAcceptHeaders` |
| --- | --- |
| `application/json` | `JSON` (1) |
| `text/html` | `HTML` (2) |
| `application/xml`, `text/xml` | `XML` (4) |
| `text/plain` | `TEXT` (8) |
| `image/png`, `image/jpeg` | `IMAGE` (16) |
| `application/pdf` | `PDF` (32) |
| none of the above | `OTHER` (64) |

`*/*` or a missing header allows every type, so it sets every flag except `OTHER`. `@AcceptType()` gives an action the same value as an argument.

## Global route middlewares

`http.routes.middlewares` mounts route middlewares on every route of every controller, before the controller's and the route's own `@Middleware` ones. An entry is one of:

- the class name of a type registered as `RouteMiddleware`, eg. with `@Injectable(RouteMiddleware)`;
- a `RouteMiddleware` class;
- `{ service, options }`: a name or a class, with `options` passed to the constructor as `@Middleware(Class, ...options)` passes them.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { GlobalRouteMiddlewareEntry, IReplyContext, RouteMiddleware } from '@spinajs/http';

export class NoSniff extends RouteMiddleware {
  public async onAfter({ res }: IReplyContext): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}

@NewInstance()
@Injectable(RouteMiddleware)
export class ApiVersion extends RouteMiddleware {
  constructor(protected Version: string = '1') {
    super();
  }

  public async onAfter({ res }: IReplyContext): Promise<void> {
    res.setHeader('Api-Version', this.Version);
  }
}

const middlewares: GlobalRouteMiddlewareEntry[] = [
  'RouteTiming', // by name: the built-in RouteTiming is registered as RouteMiddleware
  NoSniff, // by class
  { service: 'ApiVersion', options: ['2'] }, // as @Middleware(ApiVersion, '2')
];

// the app's config file
export default { http: { routes: { middlewares } } };
```

- Order: the global entries in config order, then the controller's, then the route's. `Stage` still applies on top: an `'outer'` middleware runs before every `'inner'` one, and an outer global one before an outer controller one. On the way out it reverses: a global middleware's `onAfter` and `onFinish` run after the controller's and the route's.
- A class that is also declared with `@Middleware` on the controller or the route is skipped as a global entry there, so it runs once per request: the `@Middleware` declaration, its position and its options win.
- `isEnabled(route, controller)` and `onRegister(route, path, controller)` are called per route, as for any route middleware. Use `isEnabled` to keep a global middleware off some routes.
- An entry is instantiated exactly as the same class in `@Middleware(Class, ...options)` on every route: `container.resolve(Class, options)` per route, so the class's lifetime decides sharing. A `@NewInstance()` class gets its own instance on each route; a singleton (the default) serves every route, together with any `@Middleware` of that class. A middleware that keeps per-route state, set in `onRegister`, must be `@NewInstance()`. Per-request state goes on `req.storage` or `res.locals`.
- The entries are checked at startup, by each controller before it builds its routes. A name that no registered `RouteMiddleware` has, a class that does not extend `RouteMiddleware`, or an entry of another shape fails the startup with `InvalidOption`, naming `http.routes.middlewares` and the entry.
- Routes only: a request that matches no route, a static file or anything answered before routing does not run them. Use a [server middleware](15-server-middlewares.md) for those.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RouteMiddleware` (abstract) | By class in `@Middleware(Class)`: `container.resolve(Class, options)`, the class's own lifetime (singleton by default). By name in `http.routes.middlewares`: a type registered as `RouteMiddleware`, resolved per route the same way | none | `RouteTiming`, `Audit`, `AcceptsMiddleware` (mounted by `@Accepts`) | Extend `RouteMiddleware` and implement only the hooks you need. To swap one everywhere, `DI.register(Mine).as(TheirMiddleware)` before `Controllers` resolves. |
| `HttpMiddleware` (abstract, extends `AsyncService`) | none: the base class of `RouteMiddleware` | none | none | Not extended directly: it declares the hooks `onBefore`, `onAfter`, `onFinish` and `onAround` with their contexts. A middleware that needs async setup overrides `resolve()`. |
| `sendReply(req, res, response, options?)` | function | the reply pipeline | none | Sends a `Response` through the `onAfter` hooks of the entered middlewares. An `onAround` that answers without `proceed()` uses it so the outer middlewares see its answer. |

`RouteMiddleware` members, all optional:

| Member | Meaning |
| --- | --- |
| `isEnabled(route, controller): boolean` | Whether the middleware runs on this route. Called once at startup. Returns `true` unless overridden. |
| `Stage?: 'beforePolicy' \| 'outer' \| 'inner'` | Where the middleware runs in the chain; unset means `'inner'`. See [Stage](#stage). |
| `onRegister?(route, path, controller)` | Called once when the route is mounted, with the mounted path. |
| `onBefore?(ctx): void \| Response \| Promise<void \| Response>` | Before the action. A returned `Response` answers. |
| `onAfter?(ctx): void \| Promise<void>` | On every reply, before it is sent: `ctx.response`, `ctx.error`. |
| `onFinish?(ctx): void \| Promise<void>` | After the response finished, or the client went away (`ctx.aborted`). |
| `onAround?(invocation, proceed): Promise<void>` | Wraps the rest of the chain. See [Around middlewares](#around-middlewares). |

### `RouteMiddleware`: custom implementation

Set `Cache-Control` per route, with the max age as a `@Middleware` option:

```ts sample
import { NewInstance } from '@spinajs/di';
import { BaseController, BasePath, Get, IController, IReplyContext, IRoute, Middleware, Ok, RouteMiddleware, RouteType } from '@spinajs/http';

/** NewInstance: each @Middleware(CacheControl, seconds) keeps its own max age. */
@NewInstance()
export class CacheControl extends RouteMiddleware {
  constructor(protected MaxAgeSeconds: number = 60) {
    super();
  }

  public isEnabled(route: IRoute, _controller: IController): boolean {
    // Never cache writes.
    return route.Type === RouteType.GET || route.Type === RouteType.HEAD;
  }

  public async onAfter({ res, error }: IReplyContext): Promise<void> {
    if (error !== undefined) {
      res.setHeader('Cache-Control', 'no-store');
    } else if (!res.hasHeader('Cache-Control')) {
      res.setHeader('Cache-Control', `public, max-age=${this.MaxAgeSeconds}`);
    }
  }
}

@BasePath('catalog')
@Middleware(CacheControl, 300)
export class CatalogController extends BaseController {
  @Get('categories')
  public categories() {
    return new Ok(['lamps', 'chairs']);
  }

  // The route-level middleware is entered after the controller-level one, so its onAfter runs first: its header
  // is set when the controller-level one looks.
  @Get('prices')
  @Middleware(CacheControl, 10)
  public prices() {
    return new Ok({ lamp: 49 });
  }
}
```

Headers set in `onAfter`, on `ctx.res` or with `ctx.response.setHeader()`, win over the `Response`'s own `IResponseOptions.Headers`: the reply pipeline adds every header the hooks set on `ctx.res`, even to the value it already had, to the response's headers, which `execute()` applies last. When a throwing `onAfter` turns the reply into an error reply, the headers the earlier hooks set on `ctx.res` are put back as they were, so the error reply never carries a header meant for the success reply; headers the error handlers set while making the error reply stay. A `Response` whose overridden `execute()` writes a header on `res` itself still wins over a hook. `Set-Cookie` is left out of this merge: the response's cookies are appended to those a hook set.

## Around middlewares

`onAround(invocation, proceed)` wraps everything after the middleware: the later middlewares, the action, the error handlers and the reply pipeline. Use it when the code before and after the route needs one scope, when the middleware may answer instead of the route, or when it must see every outcome; `onBefore`, `onAfter` and `onFinish` are enough for the rest.

- `proceed()` runs the rest of the chain and settles when the response finished. It can be called once: a second call rejects, and so does a call after `onAround` settled, for example from a timer.
- Not calling `proceed()` ends the chain, and the middleware answers itself. Send a `Response` with `sendReply(invocation.req, invocation.res, response)` so the entered middlewares' `onAfter` see it; writing `res` directly works too, but skips them. A middleware that neither proceeds nor answers gets a 500. The answer must be sent, or its sending awaited, before the `onAround` promise settles, for example `await new Promise((r) => res.once('finish', r))` after `sendFile` or `pipe`; otherwise the request is answered 500.
- A throw before `proceed()` goes to the route's error handlers. A throw after it is logged on the `http` logger, because the chain has already run.
- Around middlewares nest in chain order: the `proceed()` of the first one includes the second one.

| What happens | `proceed()` |
| --- | --- |
| The response finished, with any status | Resolves `{ reply, error? }`. `reply` is the `CapturedJsonReply` that was sent, after every `onAfter` change, or `null` when the answer was not a JSON reply. It is built on its first read (a second JSON serialization of the body), so an `onAround` that does not read it costs nothing. `error` is the error the chain raised, when the error handlers answered it, or the error of a throwing `onAfter`. |
| The client went away before `proceed()` | Rejects with `RouteClientGone`, `beforeRoute: true`. Nothing after the middleware ran. |
| The client went away after the chain started, before the answer | Rejects with `RouteClientGone`, `beforeRoute: false`. The action may still be running. |

When an error handler turns the error into another one, `error` is the last one. The exception is an error with `crash: true`: once recorded, it is kept.

`@Idempotent` replays a stored reply through `sendReply` as a `ReplayedResponse`: the `onAfter` of the middlewares entered before the idempotency gate run for a replay too. Those are the `'beforePolicy'` and `'outer'` ones applied before it: global and controller ones, and route ones written below `@Idempotent` (decorators apply bottom-up, see [Entered middlewares](#entered-middlewares)). The inner middlewares and the action do not run, so they see nothing of it.

On a replay `ctx.response.data` is the stored JSON body, which those outer hooks already shaped on the first answer. A hook that changes data checks `ctx.response instanceof ReplayedResponse` and leaves a replay alone; otherwise it applies itself a second time, and the client gets that. The stored bytes are sent unless a hook changed `data`; then the stored `ETag` is dropped. Headers a hook adds are never stored, except `Content-Type`, `Location` and `ETag`, which describe the body: a replay restores the route's own headers only ([Idempotency](26-idempotency.md#headers-of-a-replay)).

### Stage

| `Stage` | Runs |
| --- | --- |
| `'beforePolicy'` | before the [policy gate](13-policies.md): it is entered first, so its `onAfter` and `onFinish` see a policy refusal (401, 403) as an error reply. The shipped [`Audit`](30-audit.md) uses it. The policies always run after the `'beforePolicy'` middlewares: when an `onBefore` answers, the gate still runs, and a refusal replaces that answer; the action never runs. |
| `'outer'` | right after the policy gate, before every `'inner'` one |
| `'inner'` (unset) | after every `'outer'` one |

Keep `'beforePolicy'` for middlewares that must observe every request of the route, refused or not: logging, auditing, metrics. It runs for callers the policies would refuse, so it must not trust the principal or do work on its behalf.

An `'outer'` middleware runs right after the policy gate, before every `'inner'` one. An outer middleware that answers alone therefore skips the inner middlewares as well as the action. Within a stage, the [entry order](#entered-middlewares) holds. On the way out the order reverses: `onAfter` and `onFinish` of the inner middlewares run before those of the outer ones, and those of the `'beforePolicy'` ones run last.

### `onRegister`

`onRegister(route, path, controller)` runs once per route, when the route is mounted, and only for enabled middlewares. Check configuration or load an optional dependency there. A throw fails the registration with `RouteRegistrationException`, which names the middleware and the route.

### State between stages

State is shared, never copied. Every hook, the action and the error handlers see the same `req`, `res` and `req.storage` objects for the whole request.

- Typed per-request state goes on `req.storage` (`IActionLocalStoregeContext`, extended by declaration merging). `ctx.storage` and `invocation.storage` are the same object.
- Untyped per-response state goes on `res.locals`.
- What an around middleware writes before `proceed()` is visible to the later middlewares, the action and the error handlers. After `proceed()` resolves, the middleware sees what they wrote.

Log how every route of a controller answered:

```ts sample
import { randomUUID } from 'node:crypto';
import { Log, Logger } from '@spinajs/log';
import { BaseController, BasePath, Get, IRouteInvocation, IRouteOutcome, Middleware, MiddlewareStage, Ok, RouteClientGone, RouteMiddleware } from '@spinajs/http';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    auditId?: string;
  }
}

export class AnswerAudit extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  @Logger('audit')
  protected Log!: Log;

  public async onAround({ storage, path }: IRouteInvocation, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    storage.auditId = randomUUID();
    try {
      const { reply, error } = await proceed();
      this.Log.info({ route: path, auditId: storage.auditId, status: reply?.status, failed: error !== undefined }, 'route answered');
    } catch (err) {
      if (!(err instanceof RouteClientGone)) throw err;
      this.Log.warn({ route: path, auditId: storage.auditId, beforeRoute: err.beforeRoute }, 'client went away');
    }
  }
}

@BasePath('reports')
@Middleware(AnswerAudit)
export class ReportsController extends BaseController {
  @Get()
  public daily() {
    return new Ok({ total: 3 });
  }
}
```

## Built-in: `RouteTiming`

`RouteTiming` adds a `route;dur=<ms>` entry to the `Server-Timing` header: the time from its `onBefore` to its `onAfter`, which covers the inner middlewares, the argument extraction, the action and the error handlers. It is an `'outer'` middleware, and it times error replies too. When the [`ServerTiming`](15-server-middlewares.md) server middleware is on, the entry joins its list, next to `total`; otherwise `RouteTiming` appends the header itself. A reply an action wrote to `res` itself gets no entry, since `onAfter` does not run for it.

```ts sample
import { BaseController, BasePath, Get, Middleware, Ok, RouteTiming } from '@spinajs/http';

@BasePath('search')
@Middleware(RouteTiming)
export class SearchController extends BaseController {
  @Get()
  public query() {
    return new Ok([]);
  }
}
// Server-Timing: route;dur=3.42, total;dur=4
```

`RouteTiming` is registered as `RouteMiddleware`, so `http.routes.middlewares: ['RouteTiming']` times every route.

## Built-in: `Audit`

`Audit` records each request of a route, with its body and query redacted, its status, error, principal and time, and
writes the record to an `AuditSink` once the response finished; the default sink logs it on the `audit` logger. Mount it
with `@Middleware(Audit, options?)` or as `'Audit'` in `http.routes.middlewares`. See [Audit](30-audit.md).

## Important behaviour

- `isEnabled()` runs once per route at startup; a middleware cannot switch itself on or off per request. Decide in `onBefore()` instead.
- `onBefore` and `onAfter` hooks are awaited one after another. A rejected `onBefore` goes to the route's error handlers; a rejected `onAfter` turns the reply into an error reply. `onFinish` hooks are started in order without waiting for each other, so a slow async `onFinish` (an audit write) does not hold back the others; a rejected one is logged.
- `onAfter` may replace `ctx.response` with another `Response`, or change the reply in place: `ctx.response.data` (the data `execute()` sends), `ctx.response.statusCode`, `ctx.response.setHeader(name, value)`. The hooks that run after it, a response capture (`@Idempotent`) and the client get the change; headers a hook adds are not captured.
- An error raised after the headers were sent (an action wrote `res`, then threw) gets no error reply: it is logged on the `http` logger, and a reply cut short drops the connection, as Express does.
- `onFinish` runs exactly once per request, after `finish`, or after `close` when the client went away (`ctx.aborted: true`). A streamed reply (SSE, a pipe) the client closed is `aborted` too, although its status and headers were sent: `ctx.res.headersSent` is then `true`.
- A singleton middleware resolved with different options keeps the first ones; use `@NewInstance()` for configurable middlewares. This holds across a global entry and a `@Middleware` of the same class too.

## Migrating from the positional hooks

The 4.x hooks take one context object; the positional arguments and `onResponse` are gone. A middleware that still defines `onResponse`, itself or through a base class, fails the route registration with `RouteRegistrationException`: it would otherwise compile and never run.

| Before | Now |
| --- | --- |
| `onBefore(req, res, route, controller)` | `onBefore({ req, res, route, controller, path, storage })`; may return a `Response` |
| `onResponse(response, route, controller)` | `onAfter(ctx)` with `ctx.response`; it now also runs for error replies: return early when `ctx.error !== undefined` to keep success-only behaviour. A leftover `onResponse` fails the registration |
| `onAfter(req, res, route, controller)`, success only | `onAfter(ctx)`, for every reply, before it is sent |
| `res.on('finish', …)` registered in `onBefore` | `onFinish(ctx)` |
| `(response as any).responseData = …` | `ctx.response.data = …`; `ctx.response.statusCode = …`; `ctx.response.setHeader(…)` |
| `onAfter` order: inner stage first, declaration order within a stage | the exact reverse of the entry order: a route's middleware before the controller's, the last declared before the first |
| `@Accepts` mounted an anonymous class | it mounts `AcceptsMiddleware` |

## Best practices

- Prefer [policies](13-policies.md) for allow/deny decisions; a policy failure is reported consistently and policies combine with AND/OR.
- Keep request data in locals or `ctx.storage`, not fields: one instance serves every request of the route.
- Use a server middleware for anything that must run on every request, including unmatched ones.

## Patterns and antipatterns

```ts
// Don't: decide per request in isEnabled(); it runs once at startup.
public isEnabled(route: IRoute) {
  return Date.now() % 2 === 0;
}

// Do: decide in onBefore().
public async onBefore({ req }: IMiddlewareContext) {
  if (req.headers['x-skip-audit']) return;
  // ...
}
```

## Examples

### Audit every write to an admin controller

The shipped [`Audit`](30-audit.md) middleware does this with redaction and a pluggable sink; this hand-written one shows the hooks.

```ts sample
import { Log, Logger } from '@spinajs/log';
import { BaseController, BasePath, Body, Del, IFinishContext, IMiddlewareContext, IReplyContext, IRoute, Middleware, NoContent, Ok, Param, Post, RouteMiddleware, RouteType } from '@spinajs/http';

export class AdminAudit extends RouteMiddleware {
  @Logger('audit')
  protected Log!: Log;

  public isEnabled(route: IRoute): boolean {
    return route.Type !== RouteType.GET;
  }

  public async onBefore({ req, controller, route, storage }: IMiddlewareContext): Promise<void> {
    this.Log.info({ method: req.method, route: `${controller?.BasePath}/${String(route?.Path)}`, ip: storage.realIp }, 'admin write started');
  }

  public async onAfter({ route, response, error }: IReplyContext): Promise<void> {
    this.Log.trace({ route: String(route?.Method), response: response.constructor.name, failed: error !== undefined }, 'admin write answered');
  }

  public onFinish({ req, res, aborted }: IFinishContext): void {
    this.Log.info({ method: req.method, url: req.originalUrl.split('?')[0], status: res.statusCode, aborted }, 'admin write finished');
  }
}

@BasePath('admin/users')
@Middleware(AdminAudit)
export class AdminUsersController extends BaseController {
  @Post('/')
  public create(@Body() user: object) {
    return new Ok(user);
  }

  @Del(':id')
  public remove(@Param() _id: number) {
    return new NoContent(null);
  }
}
```

## Related

- [Policies](13-policies.md): the gate before the middlewares.
- [Server middlewares](15-server-middlewares.md): global Express middlewares.
- [Responses](10-responses.md): the `Response` object `onAfter` receives as `ctx.response`.
- [Error handling](11-error-handling.md): the error handlers that produce error replies.
- [Controllers and routing](02-controllers-and-routing.md): where the chain is built.
