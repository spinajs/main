# `@spinajs/cache`

Named caches for a SpinaJS application. An entry is valid while the versions of its tags have not moved: an
invalidation bumps a tag, it never searches for entries, and a value computed before the bump is stored already
invalid.

- `cache(name).wrap(key, { ttl, swr, tags }, compute)`: one computation per key per process, stale-while-revalidate.
- Stores: `MemoryCacheStore` (count and byte bounds), `TieredCacheStore` (memory in front of a shared store).
- `TagBus`: carries invalidations to the other processes.

Nothing is cached unless the application asks for it. See `docs/cache/README.md`.
