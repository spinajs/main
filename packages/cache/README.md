# `@spinajs/cache`

Named caches for a SpinaJS application. An entry is valid while the versions of its tags have not moved: an
invalidation bumps a tag, it never searches for entries, and a value computed before the bump is stored already
invalid.

- `cache(name).wrap(key, { ttl, tags }, compute)`, `get`, `set`, `lookup`, `delete`, `invalidate`: named caches
  configured under `cache.caches`.
- `wrap` runs one computation per key and tag versions, and serves a stale value while one refresh runs (`swr`).
- `MemoryCacheStore` (count and byte bounds).

Nothing is cached unless the application asks for it. See `docs/cache/README.md`.
