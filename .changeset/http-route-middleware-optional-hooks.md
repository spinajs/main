---
"@spinajs/http": minor
---

`RouteMiddleware` is the one route-middleware type, and every hook on it is optional: `onBefore`, `onResponse` and `onAfter` join `onRegister` and `onAround`, and `isEnabled()` returns `true` unless overridden. A middleware implements only the hooks it needs, and a hook it leaves out adds no handler to the route chain. The unreleased `AroundMiddleware` base class is removed: extend `RouteMiddleware` and implement `onAround`. Code that called a hook directly on a `RouteMiddleware` (`m.onBefore(...)`) now checks for it first. New `RouteTiming` route middleware: `@Middleware(RouteTiming)` adds a `route;dur=<ms>` entry, the time from its `onBefore` to its `onAfter`, to the `Server-Timing` header.
