# Tag bus and tiered stores

## The tag bus

`invalidate(tags)` bumps the tags in every configured cache of the process at once and publishes the bumps on the
`TagBus`. Every bump the bus delivers is applied the same way, also the echo of the process's own bumps, which costs a
miss and nothing else. A delivery opens a configured cache the process has not used yet, so its shared store hears it.

| Bus | When it is the bus |
| --- | --- |
| `InProcessTagBus` | No other package ranks a bus higher. One process only: other replicas keep their entries until they end. |
| A bus of another package | It is registered under `TagBus` and its package called `preferTagBus('<Class>', rank)` with a rank above 0. |
| Any registered bus | `cache.bus` names it. A name nobody registered fails the first cache call with `InvalidOption`. |

A bus message carries tags and the stamps of their bumps, never a key or a value, and a bus never re-stamps a bump.
Tags are not scoped: a bump of `any:invoice` in one tenant bumps that tag for every tenant, which costs misses and
never shares a value. A failed publish is logged; the local bumps stand. Disposing the container ends the subscription.

## Tiered store

```json
{ "cache": { "caches": { "shared": { "store": "TieredCacheStore", "lower": "RedisCacheStore", "consistency": "eventual" } } } }
```

A `MemoryCacheStore` (`upper`, the default and the only store allowed there) in front of a shared store (`lower`).

| Consistency | A read | Stale for at most |
| --- | --- | --- |
| `eventual` (default) | the upper tier; on a miss there, the lower tier, whose entry is copied up with its own lifetime | the bus delay; with a lost message, until the entry ends |
| `strict` | the lower tier, every time, also while it is down (a miss) | nothing the lower tier does not show |

The `consistency` option of a read overrides the cache's setting for one call. A copy ends when the entry it copied
ends; an entry read while a bump reached the upper tier is served and not copied. A write goes to the upper tier, then
to the lower one, each under the versions read before the value was computed, so a bump in between leaves both invalid.

When the lower tier fails, what only it holds is a miss and new entries stay in the upper tier. After
`cache.breaker.failures` failures in a row (default 5, at least 1) it is not called for `cache.breaker.resetAfter`
(default `'10s'`, above 0), then one call at a time until one succeeds. A wrong value fails the boot and names the key.

Bumps always go to the lower tier, open breaker or not. When it refuses one, this process reads its entries under that
tag as misses until a later bump of the tag reaches it, or until `cache.maxTtl` has passed and every entry read before
the bump has ended. The bump is not sent again: a process that did not apply it reads the old entry as valid until
another process bumps the tag there or the entry ends.
