# `@spinajs/cache`

Named caches for a SpinaJS application. An entry is valid while the versions of its tags have not moved: an
invalidation bumps a tag, it never searches for entries, and a value computed before the bump is stored already
invalid.

This version holds the contracts (`Cache`, `CacheStore`, `CacheEntry`, `TagBump`), value encoding, store keys and tags,
and `MemoryCacheStore` (count and byte bounds). Named caches, tiered stores and the tag bus follow.
