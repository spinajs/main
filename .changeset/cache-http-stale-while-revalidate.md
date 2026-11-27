---
"@spinajs/cache-http": minor
---

`@ResponseCache` takes `swr`: after `ttl`, the first request of a process runs the route again while every other request of the key gets the expired reply from the store, only while the cache still holds it valid for that request (never after an invalidation, never in another cache scope). Concurrent requests that find nothing in one process wait for the one that runs the route instead of running it too, each for at most `cache.http.timeout`, and then look the key up again in their own scope; when that run stores nothing, each of them runs the route itself. The documentation moved to `docs/cache-http/README.md`.
