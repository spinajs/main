# Controllers and routing

A controller is a class that extends `BaseController`; each decorated method is a route. `@BasePath` sets the URL prefix of the controller, `@Get`, `@Post`, `@Put`, `@Patch`, `@Del` and `@Head` set the method and path of each route. The `Controllers` service finds every controller, builds an Express router for each and mounts them on the server.

## How it works

**At import.** Every route decorator writes into the class's own controller descriptor (`IControllerDescriptor`, metadata key `CONTROLLED_DESCRIPTOR_SYMBOL`): base path, routes, parameters, policies, middlewares, and the source file of the class, taken from the V8 stack.

**At startup**, `DI.resolve(Controllers)` runs `Controllers.resolve()`:

1. `Controllers.listControllers()` asks every [`ControllerSource`](03-controller-discovery.md) for controllers and merges the lists. For the same class, an entry with a real file wins over a `<di>` entry.
2. It keeps the first entry per class **name** and registers each class with `DI.register(type).as(BaseController)`.
3. It resolves `Array.ofType(BaseController)`. A class registered as an override of another controller replaces it here (see [Overriding a controller](#overriding-a-package-controller)).
4. For each instance, `BaseController.resolve()` builds the router. Per route it:
   - throws `RouteRegistrationException` when no HTTP method decorator ran (`InternalType` is `unknown`);
   - computes the path with `buildRoutePath()`;
   - resolves the route's [middlewares](14-route-middlewares.md) and [policies](13-policies.md) from DI and keeps the middlewares whose `isEnabled()` returns `true`;
   - mounts this handler chain: policy gate → each `onBefore` → the action → each `onAfter` → response handler → error handler.
5. `Controllers.register()` reads the parameter names of each action from the [controller cache](21-controller-cache-and-cli.md) and writes them into the route parameters. It throws `ControllerRegistrationException` when the controller has no router, and `RouteRegistrationException` when a route names a method that does not exist.
6. It mounts the shared controllers router on the server with `HttpServer.use()`.

**Per request**, the action handler:

1. extracts the [route arguments](04-route-arguments.md) and appends `req`, `res` and `next` after them;
2. calls the action inside `AsyncLocalStorage.run(req.storage, …)` (see [Request storage](19-request-storage-and-tracing.md));
3. passes a returned `Response` to each middleware's `onResponse()` and stores it in `res.locals.response`;
4. lets the response handler run `response.execute()`. Any error goes to the [error handler](11-error-handling.md).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@BasePath(path)` | class | `path`: string, no leading slash; or `{ config, default }` | URL segment for every route of the controller. With `{ config, default }` the segment is the value of the configuration key `config`, read when the routes are built, and `default` while the key is unset. Without the decorator: the class name in lower case (`UsersController` → `userscontroller`). |
| `@Get(path?, schema?)` | method | `path`: route path; `schema`: `{ [paramName]: JSONSchema }` | `GET` route. |
| `@Post(path?, schema?)` | method | same | `POST` route. |
| `@Put(path?, schema?)` | method | same | `PUT` route. |
| `@Patch(path?, schema?)` | method | same | `PATCH` route. |
| `@Del(path?, schema?)` | method | same | `DELETE` route. |
| `@Head(path?, schema?)` | method | same | `HEAD` route. |
| `@Policy(...)` | class or method | see [Policies](13-policies.md) | Guards the controller or route. |
| `@Middleware(type, ...options)` | class or method | see [Route middlewares](14-route-middlewares.md) | Runs code around the route. |
| `@Accepts(types)` | class or method | `HttpAcceptHeaders` flags | Refuses requests whose `Accept` header is not one of `types`. |

The `schema` map of a route decorator wins over the schema of a parameter decorator; see [Route arguments](04-route-arguments.md#validation-and-conversion).

Decorator order does not matter: every decorator writes into the same descriptor.

### Path rules

`buildRoutePath(basePath, route, prefix)` computes the Express path:

| Declaration | Path |
| --- | --- |
| `@BasePath('users')` + `@Get()` on `refresh()` | `/users/refresh` (method name) |
| `@BasePath('users')` + `@Get('/')` | `/users` |
| `@BasePath('users')` + `@Get(':id')` | `/users/:id` |
| `@BasePath('users')` + `@Get('grants/:id')` | `/users/grants/:id` |
| `@BasePath('/')` + `@Get('health')` | `/health` |
| no `@BasePath` on `UsersController` + `@Get('list')` | `/userscontroller/list` |
| `http.controllers.route.prefix: 'api/v1'` | `/api/v1` before any of the above |
| `@BasePath({ config: 'x.base', default: 'a/b' })` + `@Get('list')`, `x.base` unset | `/a/b/list` |
| the same, `x.base: 'admin/b'` | `/admin/b/list` |

Write paths without a leading slash: `@Get('/list')` produces `/users//list`. Express path syntax applies (`:id`, `{*rest}`).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.controllers.route.prefix` | `string` | `''` | path without slashes at the ends | Prepended to every controller route. |
| `system.dirs.controllers` | `string[]` | not set | directories | Scanned by `FilesystemControllerSource`. |

```ts
export default {
  system: { dirs: { controllers: ['/app/dist/controllers'] } },
  http: { controllers: { route: { prefix: 'api/v1' } } },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| A controller | `BaseController` list (`Array.ofType(BaseController)`); each controller a singleton | your controllers | controllers shipped by packages (`@spinajs/authz-http`, `@spinajs/users-http`, ...) | Subclass the controller and `DI.register(Mine).as(Theirs)` before `Controllers` resolves; see below. |
| `Controllers` | Class `Controllers`, singleton, resolved by the app entry | `Controllers` | none shipped | Subclass and `DI.register(MyControllers).as(Controllers)`. Override `getSources()` to choose the sources, or `listControllers()` to filter the merged list. |
| `ControllerSource` | `ControllerSource` list | `FilesystemControllerSource`, `DiRegistryControllerSource` | your source | See [Controller discovery](03-controller-discovery.md). |

`BaseController` gives every controller these protected members: `_container` (root `IContainer`), `_validator` (`DataValidator`), `_log` (`http` logger), `_actionLocalStorage` (`AsyncLocalStorage` of the request storage) and `_cfg` (`Configuration`). The public `Router`, `Descriptor` and `BasePath` getters describe the built routes.

### Overriding a package controller

A controller that extends another one gets its own copy of the parent's descriptor: it inherits every route, base path, policy and middleware, and a route it redeclares changes only the subclass. Register the subclass as an override so only it mounts:

```ts sample
import { DI } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';

// Shipped by a package.
@BasePath('profiles')
export class ProfilesController extends BaseController {
  @Get(':id')
  public get(@Param() id: number) {
    return new Ok({ id, name: 'from package' });
  }

  @Get('/')
  public list() {
    return new Ok([]);
  }
}

// In your app: same routes, one changed, one added.
export class AppProfilesController extends ProfilesController {
  @Get(':id')
  public get(@Param() id: number) {
    return new Ok({ id, name: 'from app', avatar: `/avatars/${id}.png` });
  }

  @Get('me/settings')
  public settings() {
    return new Ok({ theme: 'dark' });
  }
}

// Before DI.resolve(Controllers): only AppProfilesController mounts, logged at info.
DI.register(AppProfilesController).as(ProfilesController);
```

Without the registration both classes mount, the loader logs a warning, and Express route order decides which one answers.

### Moving a controller to another path

A package controller that declares `@BasePath({ config, default })` mounts at `default` until the app sets the key:

```ts
@BasePath({ config: 'authz.http.admin.basePath', default: 'authz' })
export class AuthzAdminController extends BaseController { /* … */ }
```

```ts
export default {
  authz: { http: { admin: { basePath: 'internal/authz' } } },
};
```

- The key is read through `Configuration.get` every time `BaseController.BasePath` is read, so the route builder and the OpenAPI builder agree. `http.controllers.route.prefix` still comes first: `api` plus `internal/authz` mounts at `/api/internal/authz/...`.
- Slashes at both ends of the value are dropped. A value that is not a non-empty string throws `RouteRegistrationException` when the controller is built.
- `IControllerDescriptor.BasePath` keeps the default and `BasePathConfig` holds the key; read `controller.BasePath` for the path that is mounted.
- A subclass that declares a plain `@BasePath('own')` leaves the key behind. A subclass that declares nothing inherits the key.

The shipped admin keys are `authn.http.admin.basePath` (default `authn/admin/users`, [credential admin routes](../authn-http/16-credential-admin-routes.md#configuration)) and `authz.http.admin.basePath` (default `authz`, [admin routes](../authz-http-admin/01-admin-routes.md#configuration)).

#### Controllers without a config key

A package controller whose `@BasePath` is a plain string has no key. Until it gets one, subclass it with your own `@BasePath` and register the subclass in place of the original, as in [Overriding a package controller](#overriding-a-package-controller):

```ts
import { DI } from '@spinajs/di';
import { BasePath } from '@spinajs/http';
import { ProfilesController } from '@spinajs/some-package';

@BasePath('internal/profiles')
export class InternalProfilesController extends ProfilesController {}

// Before DI.resolve(Controllers): only InternalProfilesController mounts.
DI.register(InternalProfilesController).as(ProfilesController);
```

The subclass inherits every route, policy and middleware, so the move changes nothing else. Without the `DI.register` call both classes mount, one at each path.

### `Controllers`: custom implementation

Override `getSources()` when an app needs full control over discovery, for example an integration test that must mount only the controllers it registers:

```ts sample
import { DI } from '@spinajs/di';
import { Controllers, ControllerSource, DiRegistryControllerSource } from '@spinajs/http';

export class RegisteredOnlyControllers extends Controllers {
  protected async getSources(): Promise<ControllerSource[]> {
    // Skip the directory scan; mount what is registered as BaseController.
    return [await DI.resolve(DiRegistryControllerSource)];
  }
}

DI.register(RegisteredOnlyControllers).as(Controllers);
```

## Important behaviour

- Startup is fail-fast. These conditions throw instead of mounting a half-working app:

  | Condition | Exception |
  | --- | --- |
  | a listed controller has no instance (not resolvable) | `ControllerRegistrationException` |
  | a controller has a descriptor but no router (`super.resolve()` not called in an overridden `resolve()`) | `ControllerRegistrationException` |
  | a route names a member that is not a method | `RouteRegistrationException` |
  | a method has route decorators (eg. `@Policy`, `@Query`) but no HTTP method decorator | `RouteRegistrationException` |
  | a `@Policy('config.key')` does not name a registered `BasePolicy` | `RouteRegistrationException` |

- A controller without any route decorator logs a warning and mounts nothing; abstract base controllers are fine.
- The loader keeps one controller per class **name**. Two controller classes with the same name in different files: only the first one mounts.
- Policies and middlewares are resolved, and `RouteMiddleware.isEnabled()` is called, once per route at startup, not per request.
- A route inherited from a base class declared in another file gets its parameter names from `Function.prototype.toString()`; see [Controller cache](21-controller-cache-and-cli.md#how-it-works).
- An action that returns `undefined` or `null` answers 404 (`ResourceNotFound`). An action must return a [`Response`](10-responses.md) instance.
- The action receives `req`, `res` and `next` after its decorated arguments. An action that writes to `res` itself and returns nothing still reaches the response handler, which raises a 404 on the already-sent response; return a `Response` instead.

## Best practices

- Give every controller an explicit `@BasePath`; the class-name fallback keeps the `Controller` suffix.
- Override package controllers with `DI.register(Mine).as(Theirs)`, not by subclassing alone.
- Keep `resolve()` overrides calling `await super.resolve()` first; it builds the router.
- Put the API version in `http.controllers.route.prefix` instead of every `@BasePath`.

## Patterns and antipatterns

```ts
// Don't: the leading slash produces /orders//pending.
@BasePath('orders')
class OrdersController extends BaseController {
  @Get('/pending')
  public pending() { return new Ok([]); }
}

// Do
@BasePath('orders')
class OrdersController extends BaseController {
  @Get('pending')
  public pending() { return new Ok([]); }
}
```

```ts
// Don't: a plain object is not a Response; execute() is missing and the request fails with 500.
@Get(':id')
public get(@Param() id: number) {
  return { id };
}

// Do
@Get(':id')
public get(@Param() id: number) {
  return new Ok({ id });
}
```

## Examples

### A versioned orders API

```ts sample
import { BaseController, BasePath, Body, Created, Del, Get, NoContent, NotFound, Ok, Param, Patch, Post, Query } from '@spinajs/http';

class OrderDto {
  public sku: string;
  public quantity: number;

  constructor(data: Partial<OrderDto>) {
    Object.assign(this, data);
  }
}

const orders = new Map<number, OrderDto>();

/** With http.controllers.route.prefix = 'api/v1' every path below starts with /api/v1. */
@BasePath('orders')
export class OrdersController extends BaseController {
  /** GET /orders?status=open */
  @Get('/')
  public list(@Query() status?: string) {
    return new Ok({ status: status ?? 'any', items: [...orders.values()] });
  }

  /** GET /orders/7 */
  @Get(':id')
  public get(@Param() id: number) {
    const order = orders.get(id);
    return order ? new Ok(order) : new NotFound({ message: `order ${id} not found` });
  }

  /** POST /orders */
  @Post('/')
  public create(@Body() order: OrderDto) {
    const id = orders.size + 1;
    orders.set(id, order);
    return new Created({ id });
  }

  /** PATCH /orders/7 */
  @Patch(':id')
  public update(@Param() id: number, @Body() order: OrderDto) {
    orders.set(id, order);
    return new Ok({ id });
  }

  /** DELETE /orders/7 */
  @Del(':id')
  public remove(@Param() id: number) {
    orders.delete(id);
    return new NoContent(null);
  }
}
```

## Related

- [Controller discovery](03-controller-discovery.md): where the controller list comes from, and `Controllers.add()`.
- [Route arguments](04-route-arguments.md): the parameter decorators.
- [Responses](10-responses.md): what an action returns.
- [Policies](13-policies.md) and [Route middlewares](14-route-middlewares.md): the rest of the handler chain.
- [`@spinajs/di`](../di/README.md): `DI.register().as()` and list resolution.
