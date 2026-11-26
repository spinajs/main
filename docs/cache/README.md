# @spinajs/cache

Named caches for a SpinaJS application. Nothing is cached unless the application asks for it.

## Tags and versions

An entry carries tags (`row:invoice:17`, `any:invoice`). Every tag has a version in the store. An entry stores the
versions its tags had **before** its value was computed, and a read returns it only while every one of them is still
current. `invalidate(tags)` moves the versions; it never searches for entries. So a value computed from old rows and
stored after the invalidation is stored already invalid.

A version is a token the store never handed out before. A store may lose one (the memory store forgets a version
`cache.maxTtl` after its last use, one hour by default; Redis may evict one; a restart loses all): the tag then gets a
new token, and an entry that holds the lost one is a miss, never a stale hit. An entry ends at most `cache.maxTtl`
after its versions were read, however long its value took to compute and however late a `lookup` was filled.

```ts
import { cache, rowTag, anyTag } from '@spinajs/cache';

const invoices = await cache().wrap(`customer:${id}:invoices`, { ttl: '5m', tags: [anyTag('invoice')] }, () => loadInvoices(id));
await cache().invalidate([rowTag('invoice', '17'), anyTag('invoice')]);
```

`rowTag`, `partTag`, `anyTag` and `bulkTag` write the four tag kinds of a table from texts. For a model's key or
column value, take the text from `rowTagKey` and `tagValue` of `@spinajs/orm`, the renderer the ORM's reads and
writes use, so that your tag is the one a write bumps. `hashKey(parts)` turns long or structured parts into a key.

## Reading and writing

| Call | What it does |
| --- | --- |
| `wrap(key, options, compute)` | The cached value, else `compute()`, run once per key and per tag versions in this process: a concurrent caller waits for a running computation of the key and gets its own copy, but only when no tag of it was invalidated since that computation began; otherwise it computes itself, and only the newest computation of a key stores its entry. A failed `compute()` rejects every caller waiting on it and stores nothing; the next call computes again. While the store cannot tell the versions, every caller computes on its own. The cache sets no timeout: a `compute()` that never settles keeps every later caller of the key waiting until a tag of it is invalidated, so give the computation its own timeout, and never call `wrap` for a key from inside that key's `compute()`, which then waits for itself. |
| `get(key)` | A fresh value, else `undefined`. |
| `lookup(key, options)` | A fresh or stale hit, or a miss with `fill(value)`, which stores under the versions read at the lookup. A stale hit has a `fill` too; it claims nothing, and the stale entry stays until a fill replaces it. For a read and a write that are two calls. |
| `set(key, value, options)` | Stores under the versions of this moment. |
| `delete(key)`, `invalidate(tags)` | Removes one entry; bumps tags in every configured cache of the process, also one the process has not used yet. |

Options: `ttl` (milliseconds or `'5m'`, above 0), `swr`, `tags`. `cache.maxTtl` (default `'1h'`) caps `ttl + swr`,
and every `ttl` is then shortened by a random fraction of itself up to `cache.ttlJitter` (default 0.1, at most 0.5),
so that entries written together do not all end together. `ttlJitter: 0` keeps every `ttl` as given.

**Stale-while-revalidate.** Between `ttl` and `ttl + swr`, `wrap` returns the stale value at once and one refresh
runs in the background; it reads the tag versions before it computes and stores under them. A failed refresh is
logged with `op: 'refresh'` and keeps the stale value until the window ends; the next stale read starts another. An
invalidated value is never served, also inside its window, and a caller that misses after an invalidation does not
wait for a refresh that began before it.

Lifetimes are read from the wall clock (`Date.now()`). When the clock is set back, entries live that much longer in
real time, also past `cache.maxTtl`; an entry an invalidation made invalid stays invalid, because versions do not
depend on the clock.

## Values

Values are stored with `node:v8`: `Date`, `Buffer`, `BigInt`, `Map` and `Set` come back as they were, and every read
gets its own copy. A function, a symbol or an instance of a class (which would come back without its methods) is
refused with `CacheValueNotSerializable`. Bytes that cannot be read back are a miss.

## Scope

Every registered `CacheScope` adds segments to every key (a tenant scope adds the tenant, for example). A scope that
answers `null` turns caching off for that call: `wrap` computes, nothing is stored. A key holds each scope's class
name and the count of its segments, so no two scopes, and no two processes that register different scopes, share an
entry by accident. Entries written by an earlier build of this package under the old key form are not found again.

```ts
class TenantScope extends CacheScope {
  public segments(): readonly string[] | null {
    return [`tenant:${currentTenantId()}`];
  }
}

DI.register(TenantScope).as(CacheScope);
```

## Failures

A failing store is a miss: the error is logged on the logger `cache` and the value is computed and returned. A store
whose `configure` fails (it cannot connect, say) is such a failure too, and is opened again on the next call. A cache
or store the configuration does not name correctly throws `CacheConfigError`, and so does a `configure` that throws it.

An invalidation never throws. A store that refuses a bump keeps serving the entries of those tags until they end, at
most `cache.maxTtl` after their versions were read; the failure is logged with `op: 'bump'`. A configured cache whose
store cannot be opened in a process (its package is not imported there) is logged once, and invalidations of that
process do not reach it.

## Configuration

```json
{
  "cache": {
    "maxTtl": "1h",
    "ttlJitter": 0.1,
    "caches": { "default": { "store": "MemoryCacheStore", "maxEntries": 50000, "maxBytes": 134217728 } }
  }
}
```

The cache `default` exists without an entry; every other name must be listed under `cache.caches`.
