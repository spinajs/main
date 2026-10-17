# Route middlewares

A route middleware runs code around one route, or around every route of a controller: before the action, after it, and with the `Response` object the action returned. Use it for cross-cutting work that belongs to specific endpoints, such as audit logging, cache headers or a content-type check. For work on every request of the server, use a [server middleware](15-server-middlewares.md).

## How it works

**At startup**, for each route, `BaseController.resolve()`:

1. Resolves the controller's middlewares, then the route's, with `container.resolve(type, options)`.
2. Keeps those whose `isEnabled(route, controller)` returns `true`. This is decided once, not per request.
3. Builds the handler chain:

| Step | Runs | Can |
| --- | --- | --- |
| 1 | policy gate | refuse the request |
| 2 | `onBefore(req, res, route, controller)` of each middleware, controller ones first | change `req`, set headers, throw to refuse |
| 3 | action, then `onResponse(response, route, controller)` of each middleware | inspect the returned `Response` |
| 4 | `onAfter(req, res, route, controller)` of each middleware | set headers; the answer is not sent yet |
| 5 | response handler | sends the answer |
| 6 | error handler | answers any error from steps 1 to 5 |

A rejected `onBefore` or `onAfter` skips the rest and goes to the error handler.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Middleware(type, ...options)` | class or method | `type`: a `RouteMiddleware` class; `options`: constructor arguments | Adds the middleware to the controller (class) or the route (method). |
| `@Accepts(types)` | class or method | `HttpAcceptHeaders` flags, eg. `HttpAcceptHeaders.JSON \| HttpAcceptHeaders.HTML` | Adds a middleware that refuses the request with `BadRequest` (400) when the `Accept` header does not map to one of `types`. |

### `@Accepts`

The `Accept` header is mapped as a whole string, case-insensitively:

| `Accept` | `HttpAcceptHeaders` |
| --- | --- |
| `text/html`, `text/*` | `HTML` (2) |
| `text/plain` | `TEXT` (8) |
| `image/png`, `image/jpeg`, `image/*` | `IMAGE` (16) |
| `application/pdf` | `PDF` (32) |
| `application/json` | `JSON` (1) |
| anything else, including `*/*`, a list such as `application/json, text/plain`, or no header | `OTHER` (64) |

`@AcceptType()` gives an action the same value as an argument.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RouteMiddleware` (abstract) | By class in `@Middleware(Class)`: `container.resolve(Class, options)`, the class's own lifetime (singleton by default) | none | the anonymous class behind `@Accepts` | Extend `RouteMiddleware` and implement all four methods. To swap one everywhere, `DI.register(Mine).as(TheirMiddleware)` before `Controllers` resolves. |

Members:

| Member | Meaning |
| --- | --- |
| `isEnabled(route, controller): boolean` | Whether the middleware runs on this route. Called once at startup. |
| `onBefore(req, res, route, controller): Promise<void>` | Before the action. |
| `onResponse(response, route, controller): Promise<void>` | With the `Response` the action returned; not called when the action returned something else. |
| `onAfter(req, res, route, controller): Promise<void>` | After the action, before the answer is sent. |

### `RouteMiddleware`: custom implementation

Set `Cache-Control` per route, with the max age as a `@Middleware` option:

```ts sample
import { NewInstance } from '@spinajs/di';
import { BaseController, BasePath, Get, IController, IRoute, Middleware, Ok, Response, RouteMiddleware, RouteType } from '@spinajs/http';
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

  public async onBefore(_req: express.Request, _res: express.Response, _route: IRoute, _controller: IController): Promise<void> {}

  public async onResponse(_response: Response, _route: IRoute, _controller: IController): Promise<void> {}

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

## Important behaviour

- `isEnabled()` runs once per route at startup; a middleware cannot switch itself on or off per request. Decide in `onBefore()` instead.
- `onResponse()` calls are not awaited: the answer can be sent before an async `onResponse()` finishes, and its rejection is not handled. Keep `onResponse()` synchronous in effect.
- `onAfter()` runs before the response handler. It cannot see the status or body that will be sent, but it can still set headers.
- An error in the action skips `onResponse()` and `onAfter()`.
- A singleton middleware resolved with different options keeps the first ones; use `@NewInstance()` for configurable middlewares.
- `@Accepts(HttpAcceptHeaders.JSON)` refuses clients that send `*/*` or a list of types (most HTTP libraries and browsers): only an exact `application/json` header passes.
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
