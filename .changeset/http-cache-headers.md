---
"@spinajs/http": minor
---

`CacheControl` takes `vary`: the request headers a reply depends on, added to `Vary` on every reply except an error reply it marks `no-store`, after what CORS, the answer or another hook put there and each field once. `appendVary()` and `mergeVary()` do the same in any `onAfter` hook. `http.etag` (`'express'`, the default, `'weak'`, `'strong'` or `false`) chooses the `ETag` Express puts on `res.send` and `res.sendFile` replies; `false` turns it off for static entries that do not set `Options.etag` too. `NotModified` and `etagMatches()` let a route middleware check `If-None-Match` against its own `ETag` and answer 304 before the action runs. The `public` option of `CacheControl` is documented as it behaves: a reply to a request with `Authorization`, or one that sets a cookie, stays `private`.
