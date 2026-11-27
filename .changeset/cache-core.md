---
"@spinajs/cache": minor
"@spinajs/util": minor
---

New package `@spinajs/cache`: the cache contracts (`Cache`, `CacheStore`, `CacheEntry`, `TagBump`, `CacheScope`), `node:v8` value encoding that refuses values it would not give back as they were, store keys and the four tag kinds of a table, and `MemoryCacheStore`, whose entries stay valid while the versions of their tags have not moved; a version is a token the store never hands out twice, and an entry whose version the store forgot is a miss. `LruTtlCache` of `@spinajs/util` gains `maxWeight` and a per-entry `weight`, a bound on the total weight held; without `maxWeight` it bounds by count as before.
