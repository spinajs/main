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
@Idempotent replay check            replays a completed key of an unrestricted principal, skipping the gate
policy gate                         refuses the request, or lets it through
onAround / onBefore                 each 'outer' middleware, then each 'inner' one, in entry order
action                              returns a Response, or throws
error handlers                      on a throw: @OnError, http.errors.handlers, the error map
reply pipeline                      once for the reply, whichever produced it:
  onAfter                             each entered middleware, inner (last entered) first
  contract check                      with http.contractTesting on: the JSON body against its schema
  response.execute()                  serialisation, headers, send
onFinish                            each entered middleware, inner first, once the response finished or the client went away
```

The reply pipeline handles every framework reply of the route: the `Response` the action returned, an error reply (from an `@OnError` handler, an `http.errors.handlers` service or the error map), a `Response` an `onBefore` returned, and a reply an `@Idempotent` route replays. Every `onAfter` sees each of them, and [contract testing](../testing/02-contract-tests.md) checks each of them once, after the last `onAfter`.

### Entered middlewares

Only a middleware the chain entered gets `onAfter` and `onFinish`, and they run in the exact reverse of the entry order. The entry order is the chain order: `'beforePolicy'`, then `'outer'`, then `'inner'`, and within a stage the [global](#global-route-middlewares) ones in config order, then the controller's, then the route's, the last two in declaration order (decorators apply bottom-up, so the lowest `@Middleware` of a list is entered first). A middleware is entered when the chain reached it and its `onBefore` resolved, or when the chain reached it and it has no `onBefore`. An around middleware is entered when its `onAround` starts.

| Case | Entered |
| --- | --- |
| The policy gate refused the request | the `'beforePolicy'` ones; none after the gate |
| An `@Idempotent` route replayed before the policy gate | the `'beforePolicy'` ones; none after them |
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

A route middleware's hooks get the route fields set. The fields are optional on `IMiddlewareContext` because the same base class, `HttpMiddleware`, carries [server middlewares](15-server-middlewares.md), whose `onBefore` and `onAround` run before routing and get only a [best-effort match](15-server-middlewares.md#the-route-before-routing).

### Reading and changing the reply

To read or change the reply of a route, write a middleware and do it in `onAfter(ctx)`: read or replace `ctx.response.data`, set `ctx.response.statusCode`, call `ctx.response.setHeader(name, value)`, or replace `ctx.response`. To observe the reply that was sent, read the `reply` of the `IRouteOutcome` that `proceed()` resolves with in an [`onAround`](#around-middlewares). The response capture behind `proceed()` and `@Idempotent` is internal to `@spinajs/http`: nothing else can attach to it.

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
| `@Deadline(ms)` | class or method | positive milliseconds | Adds `DeadlineMiddleware`, which moves the request's deadline earlier, never later; see [Request deadlines](29-request-deadlines.md). |
| `@Accepts(types)` | class or method | `HttpAcceptHeaders` flags, eg. `HttpAcceptHeaders.JSON \| HttpAcceptHeaders.HTML` | Adds `AcceptsMiddleware`, which refuses the request with `ExpectedResponseUnacceptable`, answered as `NotAcceptable` (406), when the `Accept` header allows none of `types`. |
| `@Consumes(...types)` | class or method | media types as `req.is()` takes them: `'application/json'`, `'text/*'`, `'json'` | Adds `ConsumesMiddleware`, which refuses a request with a body of none of `types` with `UnsupportedMediaTypeException`, answered as `UnsupportedMediaType` (415). See [`@Consumes`](#consumes). |
| `@NoCompression()` | class or method | none | Adds `NoCompressionMiddleware`, which keeps the `Compression` server middleware off the replies. See [`@NoCompression`](#nocompression). |
| `@SlowThreshold(ms)` | class or method | milliseconds, `Infinity` for never | Adds `SlowThresholdMiddleware`: the `SlowRequestWarning` server middleware judges the route's requests against `ms` in place of `http.slowRequest.thresholdMs`. See [`@SlowThreshold`](#slowthreshold). |
| `@Deprecated(options)` | class or method | `{ since: Date, sunset?: Date, link?: string }` | Adds `DeprecationMiddleware`, which sets `Deprecation`, `Sunset` and `Link: rel="deprecation"` on every reply. See [Built-in: `@Deprecated`](#built-in-deprecated). |
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

### `@Consumes`

`@Consumes(...types)` checks the request's `Content-Type` against `types` with Express's `req.is()`, which ignores parameters such as `charset`, and takes wildcards (`text/*`) and extensions (`json`). A request without a body (no `Transfer-Encoding`, no `Content-Length` or `Content-Length: 0`) passes, whatever its method. A body without a `Content-Type` is refused, an empty one sent with `Transfer-Encoding: chunked` too: the request announces a body. Every 415 is logged on the `http` logger like any error of the route, as the 406 of `@Accepts` is. The 415 answer is the error answer of `UnsupportedMediaTypeException`, the same shape as the 406 of `@Accepts`: a problem document whose `detail` names the accepted types, or the HTML error page for an HTML client. `@Consumes()` without a type throws `InvalidArgument` at import.

With `@Consumes` on both the controller and a route, the route's declaration replaces the controller's on that route.

```ts sample
import { BaseController, BasePath, Body, Consumes, Ok, Post } from '@spinajs/http';

@BasePath('imports')
@Consumes('application/json')
export class ImportsController extends BaseController {
  @Post()
  public create(@Body() data: object) {
    return new Ok(data);
  }

  @Post('csv')
  @Consumes('text/csv')
  public csv(@Body() rows: string) {
    return new Ok({ size: rows.length });
  }
}
// POST /imports with Content-Type: text/plain -> 415 { detail: 'the request body must be application/json' }
```

### `@NoCompression`

`@NoCompression()` sends the replies of the route, or of every route of the controller, uncompressed whatever `Accept-Encoding` asks: its `onBefore` marks the response, and the `Compression` server middleware's filter, asked when the headers go out, leaves a marked response alone. Use it for a body that is already compressed (an archive, an image), one the client reads as it streams, or one that mixes a secret with input the client controls, where compression would leak the secret through the length (BREACH). It is an `'outer'` middleware, so an answer an inner middleware gives is uncompressed too; an answer given before it ran, such as the policy gate's refusal, is still compressed.

```ts sample
import { BaseController, BasePath, Get, NoCompression, Ok } from '@spinajs/http';

@BasePath('exports')
export class ExportsController extends BaseController {
  @Get('report')
  @NoCompression()
  public report() {
    return new Ok({ rows: [] });
  }
}
```

### `@SlowThreshold`

`SlowRequestWarning` logs a request that took `http.slowRequest.thresholdMs` (1000 by default) or longer. `@SlowThreshold(ms)` sets another threshold for the route, or for every route of the controller; a route's own declaration wins over the controller's. `Infinity` never warns: use it for a long poll, a report export or a stream, which are slow on purpose. A negative value or `NaN` throws `InvalidArgument` at import.

`SlowThresholdMiddleware` is an `'outer'` middleware whose `onBefore` puts `ms` on `req.storage.slowThresholdMs`, which `SlowRequestWarning.onFinish` reads. A request the policy gate refused, or one that matched no route, keeps the configured threshold.

```ts sample
import { BaseController, BasePath, Get, Ok, SlowThreshold } from '@spinajs/http';

@BasePath('reports')
@SlowThreshold(5000)
export class ReportsController extends BaseController {
  @Get('daily')
  public daily() {
    return new Ok({ total: 3 });
  }

  @Get('export')
  @SlowThreshold(Infinity)
  public export() {
    return new Ok([]);
  }
}
```

## Global route middlewares

`http.routes.middlewares` mounts route middlewares on every route of every controller, before the controller's and the route's own `@Middleware` ones. An entry is one of:

- the class name of a type registered as `RouteMiddleware` (`@Injectable(RouteMiddleware)`), or of a `RouteMiddleware` class registered under its own name (`@Injectable()`);
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
- The entries are checked at startup, by each controller before it builds its routes. A name that no registered `RouteMiddleware` has, a class that does not extend `RouteMiddleware`, or an entry of another shape fails the startup with `InvalidOption`, naming `http.routes.middlewares` and the entry. `spinajs doctor` reports an unknown name before that, as `CFG004`, with the closest registered name: from the loaded configuration with `--config`, else from the names `spinajs build` recorded in the manifest (`globalRouteMiddlewares`).
- Routes only: a request that matches no route, a static file or anything answered before routing does not run them. Use a [server middleware](15-server-middlewares.md) for those.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RouteMiddleware` (abstract) | By class in `@Middleware(Class)`: `container.resolve(Class, options)`, the class's own lifetime (singleton by default). By name in `http.routes.middlewares`: a type registered as `RouteMiddleware`, or a `RouteMiddleware` class registered under that name, resolved per route the same way | none | `RouteTiming`, `CacheControl`, `NoStore`, `AcceptsMiddleware` (mounted by `@Accepts`), `ConsumesMiddleware` (mounted by `@Consumes`), `NoCompressionMiddleware` (mounted by `@NoCompression`), `SlowThresholdMiddleware` (mounted by `@SlowThreshold`), `DeprecationMiddleware` (mounted by `@Deprecated`) | Extend `RouteMiddleware` and implement only the hooks you need. To swap one everywhere, `DI.register(Mine).as(TheirMiddleware)` before `Controllers` resolves. |
| `HttpMiddleware` (abstract, extends `AsyncService`) | none: the base class of `RouteMiddleware` | none | none | Not extended directly: it declares the hooks `onBefore`, `onAfter`, `onFinish` and `onAround` with their contexts. A middleware that needs async setup overrides `resolve()`. |
| `sendReply(req, res, response, options?)` | function | the reply pipeline | none | Sends a `Response` through the `onAfter` hooks of the entered middlewares. An `onAround` that answers without `proceed()` uses it so the outer middlewares see its answer. |
| `resolveConfiguredTypes(key, base, entries, container)` | function | none | none | Turns the entries of a config key that lists services (`'Name' \| Class \| { service, options }`) into `{ type, entry, options }`, in config order, the way `http.routes.middlewares`, `http.errors.handlers` and `http.upload.middlewares` read theirs. A name is a type registered as `base` or a `base` subclass registered under that name. An unknown name, a class that does not extend `base` or an entry of another shape throws `InvalidOption` naming `key` and the entry. Instances are left to the caller. |

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

Set `X-Robots-Tag` per route, with the directive as a `@Middleware` option:

```ts sample
import { NewInstance } from '@spinajs/di';
import { BaseController, BasePath, Get, IController, IReplyContext, IRoute, Middleware, Ok, RouteMiddleware, RouteType } from '@spinajs/http';

/** NewInstance: each @Middleware(RobotsTag, directive) keeps its own directive. */
@NewInstance()
export class RobotsTag extends RouteMiddleware {
  constructor(protected Directive: string = 'noindex') {
    super();
  }

  public isEnabled(route: IRoute, _controller: IController): boolean {
    // Only pages a crawler fetches.
    return route.Type === RouteType.GET;
  }

  public async onAfter({ res }: IReplyContext): Promise<void> {
    if (!res.hasHeader('X-Robots-Tag')) {
      res.setHeader('X-Robots-Tag', this.Directive);
    }
  }
}

@BasePath('catalog')
@Middleware(RobotsTag, 'noindex')
export class CatalogController extends BaseController {
  @Get('categories')
  public categories() {
    return new Ok(['lamps', 'chairs']);
  }

  // The route-level middleware is entered after the controller-level one, so its onAfter runs first: its header
  // is set when the controller-level one looks.
  @Get('prices')
  @Middleware(RobotsTag, 'noindex, nofollow')
  public prices() {
    return new Ok({ lamp: 49 });
  }
}
```

Headers set in `onAfter`, on `ctx.res` or with `ctx.response.setHeader()`, win over the `Response`'s own `IResponseOptions.Headers`. When `execute()` of the reply then fails (its data rejects), the headers the hooks set on `ctx.res` are put back as they were before the hooks, so the error reply the failure is answered with does not carry them: the reply pipeline adds every header the hooks set on `ctx.res`, even to the value it already had, to the response's headers, which `execute()` applies last. When a throwing `onAfter` turns the reply into an error reply, the headers the earlier hooks set on `ctx.res` are put back as they were, so the error reply never carries a header meant for the success reply; headers the error handlers set while making the error reply stay. A `Response` whose overridden `execute()` writes a header on `res` itself still wins over a hook. `Set-Cookie` is left out of this merge: the response's cookies are appended to those a hook set.

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

`@Idempotent` replays a stored reply through `sendReply` as a `ReplayedResponse`: the `onAfter` of the middlewares entered before the idempotency gate run for a replay too. Those are the `'beforePolicy'` and `'outer'` ones applied before it: global and controller ones, and route ones written below `@Idempotent` (decorators apply bottom-up, see [Entered middlewares](#entered-middlewares)). The inner middlewares and the action do not run, so they see nothing of it. A replay for an authenticated, unrestricted principal on a route with policies is answered earlier, right after the `'beforePolicy'` stage and before the policy gate: only the `'beforePolicy'` middlewares are entered for it, so a middleware that decorates replies belongs in `'beforePolicy'` ([Middlewares on an early replay](26-idempotency.md#middlewares-on-an-early-replay)).

On a replay `ctx.response.data` is the stored JSON body, which those outer hooks already shaped on the first answer. A hook that changes data checks `ctx.response instanceof ReplayedResponse` and leaves a replay alone; otherwise it applies itself a second time, and the client gets that. The stored bytes are sent unless a hook changed `data`; then the stored `ETag` is dropped. Headers a hook adds are never stored, except `Content-Type`, `Location` and `ETag`, which describe the body: a replay restores the route's own headers only ([Idempotency](26-idempotency.md#headers-of-a-replay)).

### Stage

| `Stage` | Runs |
| --- | --- |
| `'beforePolicy'` | before the [policy gate](13-policies.md): it is entered first, so its `onAfter` and `onFinish` see a policy refusal (401, 403) as an error reply. The shipped [`Audit`](30-audit.md) uses it. The policies always run after the `'beforePolicy'` middlewares: when an `onBefore` answers, the gate still runs, and a refusal replaces that answer; the action never runs. The one exception is an `@Idempotent` replay of an unrestricted principal's completed request, which is answered right after this stage without the policies ([Replays before the policies](26-idempotency.md#replays-before-the-policies)). |
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

## Built-in: `CacheControl` and `NoStore`

`CacheControl(maxAge, options?)` sets `Cache-Control` on the replies of a GET, HEAD or FILE route; other routes do not mount it.

| Reply | `Cache-Control` |
| --- | --- |
| 2xx or 304 | `max-age=<maxAge>` and the options below |
| 2xx or 304 to a request with `Authorization`, or one that sets a cookie (`IResponseOptions.Coockies`, or `res.cookie()` before `CacheControl`'s `onAfter`; a cookie a later `onAfter`, such as a server middleware's, sets is not seen) | `private, max-age=<maxAge>`, even with `public: true`: a shared cache must not hand one client's answer or cookie to another |
| other 3xx | none, unless `redirects: true`: a redirect to a login page must not be kept for everyone |
| an error reply, or 400 and above | `no-store`, so a cache never keeps a failure |
| a reply that fails while it is sent (eg. its data rejects) | none: the error reply the failure is answered with drops the headers the `onAfter` hooks set for the failed reply |

| Option | Directive |
| --- | --- |
| `public: true` | `public`: a shared cache may keep the reply even to a request with `Authorization` (RFC 9111 §3.5); off by default |
| `private: true` | `private`: only the browser may keep the reply |
| `redirects: true` | 3xx replies get the directives too |
| `staleWhileRevalidate: <seconds>` | `stale-while-revalidate=<seconds>` (RFC 5861) |
| `immutable: true` | `immutable` (RFC 8246) |

`maxAge` and `staleWhileRevalidate` must be non-negative integers, and `public` and `private` exclude each other; another value throws `InvalidArgument` when the route is built. A `Cache-Control` the answer set itself (`IResponseOptions.Headers`) or an earlier step set on `res` (the `no-store` of an authenticated request) is kept. With `CacheControl` on both the controller and the route, the route's wins: its `onAfter` runs first.

`NoStore` sets `Cache-Control: no-store` and `Pragma: no-cache` on every reply of the route: in `onBefore`, so a reply the action writes to `res` itself has them, and again in `onAfter`, so they win over a `Cache-Control` the answer set itself and go out with error replies. Use it for answers that hold a secret: a token, a share link. A refusal of the policy gate comes before it and does not get them.

```ts sample
import { BaseController, BasePath, CacheControl, Get, Middleware, NoStore, Ok, Post } from '@spinajs/http';

@BasePath('products')
@Middleware(CacheControl, 300)
export class ProductsController extends BaseController {
  @Get()
  public list() {
    return new Ok([]);
  }
  // Cache-Control: max-age=300

  @Get('featured')
  @Middleware(CacheControl, 60, { staleWhileRevalidate: 30 })
  public featured() {
    return new Ok([]);
  }
  // Cache-Control: max-age=60, stale-while-revalidate=30

  @Post('share')
  @Middleware(NoStore)
  public share() {
    return new Ok({ link: 'https://example.com/s/abc' });
  }
  // Cache-Control: no-store, Pragma: no-cache
}
```

Both are registered as `RouteMiddleware`: `http.routes.middlewares: ['NoStore']` marks every route, `{ service: 'CacheControl', options: [60] }` every GET route. The `private` downgrade only sees `Authorization` and cookies set on the reply: a per-user reply authenticated by a session cookie the request carries, with no `no-store` from the authentication (authn-http sets one), goes out `max-age=60`, and a shared cache may keep it. Declare `private: true` or `NoStore` on routes that answer per user. `CacheControl` is `@NewInstance()`, so each declaration keeps its own options.

For one answer only, put the exported `NO_STORE` header (`{ Name: 'Cache-Control', Value: 'no-store' }`) in its `IResponseOptions.Headers`: `new Ok(body, { Headers: [NO_STORE] })`.

## Built-in: `@Deprecated`

`@Deprecated(options)` on a route, or on a controller for every route of it, mounts `DeprecationMiddleware`, which announces the deprecation on every reply, error replies included:

| Option | Header |
| --- | --- |
| `since: Date`, required | `Deprecation: @<unix seconds>` (RFC 9745): when the route was deprecated |
| `sunset: Date` | `Sunset: <HTTP-date>` (RFC 8594): when the route stops answering |
| `link: string` | `Link: <link>; rel="deprecation"` (RFC 9745): a page about the deprecation and the way off it |

A missing `since` (RFC 9745 defines the header as a date only), an invalid `Date`, a `sunset` before `since`, or a `link` that is empty or holds spaces or angle brackets throws `InvalidArgument` at the decorator, so the module fails at import. A `Link` the answer set itself is kept: the deprecation link joins it. A reply that fails while it is sent (its data rejects) is answered with an error reply that carries none of these headers: the reply pipeline drops what the `onAfter` hooks set for the failed reply. With `@Deprecated` on both the controller and a route, the route's declaration replaces the controller's on that route; the same holds for a subclass of `DeprecationMiddleware` mounted with `@Middleware`, and for a class registered in its place with `DI.register(Mine).as(DeprecationMiddleware)`. Mounted by name (`http.routes.middlewares`), `DeprecationMiddleware` needs its options too: `{ service: 'DeprecationMiddleware', options: [{ since }] }`.

```ts sample
import { BaseController, BasePath, Deprecated, Get, Ok } from '@spinajs/http';

@BasePath('orders')
export class OrdersController extends BaseController {
  @Get('legacy-list')
  @Deprecated({ since: new Date('2026-01-01T00:00:00Z'), sunset: new Date('2026-12-31T23:59:59Z'), link: 'https://example.com/docs/orders-v2' })
  public legacyList() {
    return new Ok([]);
  }
}
// Deprecation: @1767225600
// Sunset: Thu, 31 Dec 2026 23:59:59 GMT
// Link: <https://example.com/docs/orders-v2>; rel="deprecation"
```

The route documentation says so too:

- The compiler records `@Deprecated` on a route or a controller in the manifest as `doc.deprecated` of the route, as the JSDoc `@deprecated` tag does, so the OpenAPI document `@spinajs/openapi` generates from the manifest marks the operation `deprecated: true`. It does not see a `DeprecationMiddleware` mounted with `@Middleware`, nor the inherited routes of a `@Deprecated` subclass.
- At runtime both controller metadata providers (`ManifestControllerMetadata` and `CacheControllerMetadata`, which http-swagger reads) mark every route whose own or controller middlewares include a `DeprecationMiddleware`, however it was mounted and inherited ones included, through `withDeprecatedRoutes(controller, documentation)`.
## Built-in: `Audit`

`Audit` records each request of a route, with its body and query redacted, its status, error, principal and time, and
writes the record to an `AuditSink` once the response finished; the default sink logs it on the `audit` logger. Mount it
with `@Middleware(Audit, options?)` or as `'Audit'` in `http.routes.middlewares`. See [Audit](30-audit.md).

## Important behaviour

- `isEnabled()` runs once per route at startup; a middleware cannot switch itself on or off per request. Decide in `onBefore()` instead.
- `onBefore` and `onAfter` hooks are awaited one after another. A rejected `onBefore` goes to the route's error handlers; a rejected `onAfter` turns the reply into an error reply. `onFinish` hooks are started in order without waiting for each other, so a slow async `onFinish` (an audit write) does not hold back the others; a rejected one is logged.
- `onAfter` may replace `ctx.response` with another `Response`, or change the reply in place: `ctx.response.data` (the data `execute()` sends), `ctx.response.statusCode`, `ctx.response.setHeader(name, value)`. The hooks that run after it, the `proceed()` outcome of an enclosing `onAround`, the reply `@Idempotent` stores and the client get the change; headers a hook adds, other than `Content-Type`, `Location` and `ETag`, are left out of the outcome's `reply` and of the stored reply.
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
