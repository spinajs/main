# Route middlewares

A route middleware runs code around one route, around every route of a controller, or around every route of the app: before the action, after it, and with the `Response` object the action returned. Use it for cross-cutting work that belongs to specific endpoints, such as audit logging, cache headers or a content-type check. For work on every request of the server, use a [server middleware](15-server-middlewares.md).

## How it works

**At startup**, for each route, `BaseController.resolve()`:

1. Resolves the [global middlewares](#global-route-middlewares), then the controller's, then the route's, with `container.resolve(type, options)`.
2. Keeps those whose `isEnabled(route, controller)` returns `true`. This is decided once, not per request.
3. Calls `onRegister(route, path, controller)` of each kept middleware that has one. A throw fails the registration.
4. Builds the handler chain from the hooks each middleware implements; a hook it leaves out adds nothing to the chain:

| Step | Runs | Can |
| --- | --- | --- |
| 1 | policy gate | refuse the request |
| 2 | each `'outer'` middleware: its `onAround` (if it has one), then `onBefore(req, res, route, controller)` | answer alone, wrap the rest of the chain, change `req`, set headers, throw to refuse |
| 3 | each `'inner'` middleware the same way: global ones, then controller ones, then route ones | the same |
| 4 | action, then `onResponse(response, route, controller)` of each middleware, inner first | inspect the returned `Response` |
| 5 | `onAfter(req, res, route, controller)` of each middleware, inner first | set headers; the answer is not sent yet |
| 6 | response handler | sends the answer |
| 7 | error handler | answers any error from steps 1 to 6 |

A rejected `onBefore` or `onAfter` skips the rest and goes to the error handler.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Middleware(type, ...options)` | class or method | `type`: a `RouteMiddleware` class; `options`: constructor arguments | Adds the middleware to the controller (class) or the route (method). |
| `@Accepts(types)` | class or method | `HttpAcceptHeaders` flags, eg. `HttpAcceptHeaders.JSON \| HttpAcceptHeaders.HTML` | Adds a middleware that refuses the request with `ExpectedResponseUnacceptable`, answered as `NotAcceptable` (406), when the `Accept` header allows none of `types`. |

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
import { GlobalRouteMiddlewareEntry, RouteMiddleware } from '@spinajs/http';
import * as express from 'express';

export class NoSniff extends RouteMiddleware {
  public async onAfter(_req: express.Request, res: express.Response): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}

@NewInstance()
@Injectable(RouteMiddleware)
export class ApiVersion extends RouteMiddleware {
  constructor(protected Version: string = '1') {
    super();
  }

  public async onAfter(_req: express.Request, res: express.Response): Promise<void> {
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

- Order: the global entries in config order, then the controller's, then the route's. `Stage` still applies on top: an `'outer'` middleware runs before every `'inner'` one, and an outer global one before an outer controller one.
- `isEnabled(route, controller)` and `onRegister(route, path, controller)` are called per route, as for any route middleware. Use `isEnabled` to keep a global middleware off some routes.
- An entry is instantiated exactly as the same class in `@Middleware(Class, ...options)` on every route: `container.resolve(Class, options)` per route, so the class's lifetime decides sharing. A `@NewInstance()` class gets its own instance on each route; a singleton (the default) serves every route, together with any `@Middleware` of that class. A middleware that keeps per-route state, set in `onRegister`, must be `@NewInstance()`. Per-request state goes on `req.storage` or `res.locals`.
- The entries are checked once at startup, before any route is built. A name that no registered `RouteMiddleware` has, a class that does not extend `RouteMiddleware`, or an entry of another shape fails the startup with `InvalidOption`, naming `http.routes.middlewares` and the entry.
- Routes only: a request that matches no route, a static file or anything answered before routing does not run them. Use a [server middleware](15-server-middlewares.md) for those.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RouteMiddleware` (abstract) | By class in `@Middleware(Class)`: `container.resolve(Class, options)`, the class's own lifetime (singleton by default). By name in `http.routes.middlewares`: a type registered as `RouteMiddleware`, resolved per route the same way | none | `RouteTiming`, the anonymous class behind `@Accepts` | Extend `RouteMiddleware` and implement only the hooks you need. To swap one everywhere, `DI.register(Mine).as(TheirMiddleware)` before `Controllers` resolves. |

Members, all optional:

| Member | Meaning |
| --- | --- |
| `isEnabled(route, controller): boolean` | Whether the middleware runs on this route. Called once at startup. Returns `true` unless overridden. |
| `Stage?: 'outer' \| 'inner'` | Where the middleware runs in the chain; unset means `'inner'`. See [Stage](#stage). |
| `onRegister?(route, path, controller)` | Called once when the route is mounted, with the mounted path. |
| `onBefore?(req, res, route, controller): Promise<void>` | Before the action. |
| `onResponse?(response, route, controller): Promise<void>` | With the `Response` the action returned, before it is sent; not called when the action returned something else. |
| `onAfter?(req, res, route, controller): Promise<void>` | After the action succeeded, before the answer is sent: headers can still be set. |
| `onAround?(invocation, proceed): Promise<void>` | Wraps the rest of the chain. See [Around middlewares](#around-middlewares). |

### `RouteMiddleware`: custom implementation

Set `Cache-Control` per route, with the max age as a `@Middleware` option:

```ts sample
import { NewInstance } from '@spinajs/di';
import { BaseController, BasePath, Get, IController, IRoute, Middleware, Ok, RouteMiddleware, RouteType } from '@spinajs/http';
import * as express from 'express';

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

  public async onAfter(_req: express.Request, res: express.Response, _route: IRoute, _controller: IController): Promise<void> {
    res.setHeader('Cache-Control', `public, max-age=${this.MaxAgeSeconds}`);
  }
}

@BasePath('catalog')
@Middleware(CacheControl, 300)
export class CatalogController extends BaseController {
  @Get('categories')
  public categories() {
    return new Ok(['lamps', 'chairs']);
  }

  // Route-level middleware runs after the controller-level one, so its header wins.
  @Get('prices')
  @Middleware(CacheControl, 10)
  public prices() {
    return new Ok({ lamp: 49 });
  }
}
```

## Around middlewares

`onAround(invocation, proceed)` wraps everything after the middleware: the later middlewares, the action, the error handlers and the response. Use it when the code before and after the route needs one scope, when the middleware may answer instead of the route, or when it must see every outcome; `onBefore` and `onAfter` are enough for the rest.

- `proceed()` runs the rest of the chain and settles when the response finished. It can be called once: a second call rejects, and so does a call after `onAround` settled, for example from a timer.
- Not calling `proceed()` ends the chain, and the middleware answers `res` itself. A middleware that neither proceeds nor answers gets a 500. The answer must be sent, or its sending awaited, before the `onAround` promise settles, for example `await new Promise((r) => res.once('finish', r))` after `sendFile` or `pipe`; otherwise the request is answered 500.
- A throw before `proceed()` goes to the route's error handlers. A throw after it is logged on the `http` logger, because the chain has already run.
- Around middlewares nest in chain order: the `proceed()` of the first one includes the second one.

| What happens | `proceed()` |
| --- | --- |
| The response finished, with any status | Resolves `{ reply, error? }`. `reply` is the `CapturedJsonReply` that was sent, or `null` when the answer was not a JSON reply. `error` is the error the chain raised, when the error handlers answered it. |
| The client went away before `proceed()` | Rejects with `RouteClientGone`, `beforeRoute: true`. Nothing after the middleware ran. |
| The client went away after the chain started, before the answer | Rejects with `RouteClientGone`, `beforeRoute: false`. The action may still be running. |

When an error handler turns the error into another one, `error` is the last one. The exception is an error with `crash: true`: once recorded, it is kept.

### Stage

An `'outer'` middleware runs right after the policy gate, before every `'inner'` one. An outer middleware that answers alone therefore skips the inner middlewares as well as the action. Within a stage, declaration order holds.

### `onRegister`

`onRegister(route, path, controller)` runs once per route, when the route is mounted, and only for enabled middlewares. Check configuration or load an optional dependency there. A throw fails the registration with `RouteRegistrationException`, which names the middleware and the route.

### State between stages

State is shared, never copied. Every hook, the action and the error handlers see the same `req`, `res` and `req.storage` objects for the whole request.

- Typed per-request state goes on `req.storage` (`IActionLocalStoregeContext`, extended by declaration merging). `invocation.storage` is the same object. The action runs inside the AsyncLocalStorage context of that object, so the services it calls read it too.
- Untyped per-response state goes on `res.locals`.
- What an around middleware writes before `proceed()` is visible to the later middlewares, the action and the error handlers. After `proceed()` resolves, the middleware sees what they wrote.
- Middleware hooks run outside the action's AsyncLocalStorage context. Pass `req` or `storage` to a service called from a hook.

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

`RouteTiming` adds a `route;dur=<ms>` entry to the `Server-Timing` header: the time from its `onBefore` to its `onAfter`, which covers the inner middlewares, the argument extraction and the action. It is an `'outer'` middleware. When the [`ServerTiming`](15-server-middlewares.md) server middleware is on, the entry joins its list, next to `total`; otherwise `RouteTiming` appends the header itself. A route that failed gets no entry, because `onAfter` runs only after a success.

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

## Important behaviour

- `isEnabled()` runs once per route at startup; a middleware cannot switch itself on or off per request. Decide in `onBefore()` instead.
- `onResponse()` calls are awaited one after another, before the response is sent. A rejection goes to the error handler instead of the response.
- `onAfter()` runs before the response handler. It cannot see the status or body that will be sent, but it can still set headers.
- An error in the action skips `onResponse()` and `onAfter()`. An around middleware still sees it, as `error` in the outcome of `proceed()`.
- A singleton middleware resolved with different options keeps the first ones; use `@NewInstance()` for configurable middlewares. This holds across a global entry and a `@Middleware` of the same class too.

## Best practices

- Prefer [policies](13-policies.md) for allow/deny decisions; a policy failure is reported consistently and policies combine with AND/OR.
- Keep request data in locals, not fields: one instance serves every request of the route.
- Use a server middleware for anything that must run on every request, including unmatched ones.

## Patterns and antipatterns

```ts
// Don't: decide per request in isEnabled(); it runs once at startup.
public isEnabled(route: IRoute) {
  return Date.now() % 2 === 0;
}

// Do: decide in onBefore().
public async onBefore(req: express.Request) {
  if (req.headers['x-skip-audit']) return;
  // ...
}
```

## Examples

### Audit every write to an admin controller

```ts sample
import { Log, Logger } from '@spinajs/log';
import { BaseController, BasePath, Body, Del, IController, IRoute, Middleware, NoContent, Ok, Param, Post, Response, RouteMiddleware, RouteType } from '@spinajs/http';
import * as express from 'express';

export class AdminAudit extends RouteMiddleware {
  @Logger('audit')
  protected Log!: Log;

  public isEnabled(route: IRoute): boolean {
    return route.Type !== RouteType.GET;
  }

  public async onBefore(req: express.Request, _res: express.Response, route: IRoute, controller: IController): Promise<void> {
    this.Log.info({ method: req.method, route: `${controller.BasePath}/${String(route.Path)}`, ip: (req as any).storage?.realIp }, 'admin write started');
  }

  public async onResponse(response: Response, route: IRoute): Promise<void> {
    this.Log.trace({ route: String(route.Method), response: response.constructor.name }, 'admin write produced a response');
  }

  public async onAfter(req: express.Request): Promise<void> {
    this.Log.info({ method: req.method, url: req.originalUrl.split('?')[0] }, 'admin write finished');
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
- [Responses](10-responses.md): the `Response` object `onResponse()` receives.
- [Controllers and routing](02-controllers-and-routing.md): where the chain is built.
