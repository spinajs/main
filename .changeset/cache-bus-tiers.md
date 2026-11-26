---
"@spinajs/cache": minor
---

`TagBus` carries invalidations between processes: `InProcessTagBus` by default, another package's bus when it ranks one higher with `preferTagBus`, any registered bus by `cache.bus`. `TieredCacheStore` puts a `MemoryCacheStore` in front of a shared store, with `consistency: 'eventual'` (served from memory, stale for at most the bus delay) or `'strict'` (every read from the shared store). A failing lower tier is a miss and is skipped for `cache.breaker.resetAfter` after `cache.breaker.failures` failures in a row; an entry of it under a tag whose bump it refused is not trusted by that process.
