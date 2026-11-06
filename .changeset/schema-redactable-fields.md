---
"@spinajs/compiler": minor
"@spinajs/manifest": minor
"@spinajs/openapi": minor
"@spinajs/asyncapi": minor
"@spinajs/client": minor
---

Generated documents and the typed client say which responses are redacted per caller. A route with `@Access(…, { fields: 'filter' | 'filter-rows' })` (its `AuthzFieldsMiddleware` entry in the manifest) and a socket command with `@SocketAccess(…, { fields })` (new `SocketCommandEntry.fields`, recorded by the compiler) answer with a copy of their schema in OpenAPI and AsyncAPI where every property is optional and carries `x-spina-fields: '<permission>'`; the shared component keeps its `required`. The client types such results as `Redacted<T>` from `@spinajs/client/runtime`: every property optional and `T[K] | undefined`, element-wise for lists. The compiler now records `AuthzFieldsMiddleware` for `fields: 'filter-rows'` too. Rebuild the manifest to pick up `fields`.
