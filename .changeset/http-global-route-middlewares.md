---
"@spinajs/http": minor
---

New `http.routes.middlewares` configuration key (default `[]`): route middlewares mounted on every route of every controller. An entry is the class name of a type registered as `RouteMiddleware`, a `RouteMiddleware` class, or `{ service, options }` with constructor options, as `@Middleware(Class, ...options)` passes them. Each entry is resolved once when the controllers start and its instance serves every route. Global entries run before the controller and route `@Middleware` ones, in config order; `Stage`, `isEnabled` and `onRegister` apply as for any route middleware. An unknown name, a class that is not a `RouteMiddleware` or an entry of another shape fails the startup with `InvalidOption`. `RouteTiming` is now `@Injectable(RouteMiddleware)`, so `routes: { middlewares: ['RouteTiming'] }` times every route. New exports: `resolveGlobalRouteMiddlewares` and the `GlobalRouteMiddlewareEntry` type.
