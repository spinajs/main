---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/cli": minor
---

The manifest records the route middlewares that decorators mount for you, as the class they mount with the decorator's literal arguments as `decoratorArgs` (`@Middleware` keeps `options`; either is left out when an argument is not a plain JSON literal): `@Accepts`, `@BotCheck`, `@Idempotent`, `@Deprecated`, `@Consumes`, `@NoCompression`, `@RateLimit`, `@Deadline` and `@SlowThreshold` of `@spinajs/http`, `@Unscoped` of `@spinajs/authz-http` and `@IpThrottle` of `@spinajs/authn-http`, each only when the decorator resolves to that package (`FACTORY_MIDDLEWARES` in `@spinajs/compiler`). An abstract controller with only such a class decorator is kept as a base. An own `@Idempotent` on a redeclared route replaces the inherited one, as at runtime. `spinajs build` records the `http.routes.middlewares` of its configuration as the optional `globalRouteMiddlewares`, by type name only (`fromClass` for a class entry; never the options, which may hold secrets), part of the hash, and `spinajs doctor` checks those names (`CFG004`, class entries skipped) without `--config`.
