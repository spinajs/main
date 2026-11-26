---
"@spinajs/cache": minor
---

`cache(name)` and `CacheService`: named caches configured under `cache.caches`, with `get`, `set`, `wrap`, `lookup`, `delete` and `invalidate`. An entry stores the versions its tags had before its value was computed, is served only while they are current, and ends at most `cache.maxTtl` after they were read. A stale `lookup` hit can be filled under the versions read at that lookup. An invalidation bumps every configured cache of the process. Every key carries the segments of the registered `CacheScope`s. A failing store is read as a miss.
