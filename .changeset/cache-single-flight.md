---
"@spinajs/cache": minor
---

`wrap` computes once per key and per tag versions in a process: a concurrent caller joins a running computation only when no tag of it was invalidated since it began, and only the newest computation of a key stores its entry. Between `ttl` and `ttl + swr` it serves the stale value while one refresh runs. `cache.ttlJitter` spreads TTLs.
