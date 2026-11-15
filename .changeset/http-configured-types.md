---
"@spinajs/http": minor
---

`http.routes.middlewares`, `http.errors.handlers` and `http.upload.middlewares` resolve their entries through one helper, `resolveConfiguredTypes(key, base, entries, container)`, exported for packages with their own service lists. Each key keeps its entry shapes and the way it passes options. A name may now also be a subclass registered under its own name (`@Injectable()`), as `http.upload.middlewares` always allowed. A controller with an upload route checks `http.upload.middlewares` at startup: an unknown name, a class that is not a `FileUploadMiddleware` or an entry of another shape fails it with `InvalidOption` naming the key and the entry, instead of failing each upload request. An `http.errors.handlers` entry that is not `{ service: '<name>' }` now fails with an `InvalidOption` naming the entry.
