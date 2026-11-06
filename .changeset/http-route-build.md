---
"@spinajs/http": minor
---

Building a controller's routes does once per controller what it did once per route: the mount path and `http.controllers.route.prefix` are read at the first route, and one error handler serves every route of the controller. A route's manifest entry is looked up through a per-manifest index by class name instead of a walk over every controller entry. `createPolicyGate` takes the mount path as an optional fifth argument; without it, it still reads `controller.BasePath`. The routes, paths and error responses do not change.
