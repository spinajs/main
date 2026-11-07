---
"@spinajs/compiler": minor
---

`spinajs doctor --config` adds `CFG004`: a name in `http.routes.middlewares` (a string or `{ service }` entry) that no type registered as `RouteMiddleware` has, with the closest registered name (`Accepts` suggests `AcceptsMiddleware`). The runtime refuses to start with such a name; the rule reports it before deployment.
