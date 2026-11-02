---
"@spinajs/http": minor
---

`defaultMiddlewares()` returns the handlers shipped as `http.middlewares`, so an app that sets its own list can keep them: `middlewares: [...defaultMiddlewares(), requestId]`. `HttpServer` logs one warning at boot when the configured list lost the shipped helmet, a body parser or the cookie parser, naming what is missing. An app's own `helmet()` carries no tag and also triggers it. `missingDefaultMiddlewares(list)` is the check.
