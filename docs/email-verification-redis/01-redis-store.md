# Redis store

`RedisEmailVerificationStore` implements `EmailVerificationStore` over one ioredis client. Use it for a shared verdict cache and shared lists across app instances, with Redis expiring verdicts for you.

## How it works

1. Importing the package registers `RedisEmailVerificationStore` under the `EmailVerificationStore` token.
2. Set `emailVerification.store` to `'RedisEmailVerificationStore'`.
3. On `resolve()` the store creates `new Redis({ keyPrefix: 'ev:', ...emailVerification.redis })` and logs connection errors to the `email-verification` logger. Your `keyPrefix` replaces the default.
4. `setVerdict()` writes JSON with a `PX` expiry; Redis removes it. A stored value that is not valid JSON, or has an unknown `result`, reads as a miss.
5. Every list write runs in a `MULTI` transaction that also does `INCR` on the version key. A transaction that is aborted, or has a failed command, throws.
6. `replaceSource()` builds the new set under a temporary key, in batches of 1000 domains, then runs one transaction: `RENAME` over the live key, `PERSIST`, `SADD` to the index, `INCR` the version. Readers see the old set or the new set. With no domains it deletes the key and the index member.
7. `dispose()` sends `QUIT`, and disconnects after 1 second if that does not finish.

## Key layout

All keys sit under `keyPrefix` (default `ev:`).

| Key | Type | Meaning |
| --- | --- | --- |
| `verdict:<verifier>:<domain>` | string (JSON) | A cached verdict; expires by `PX` |
| `list:<kind>:<source>` | set | Domains of one list source |
| `lists` | set | Index of `<kind>:<source>` members that exist |
| `internal:listVersion` | string | Counter bumped by `INCR` on every list write |
| `meta:<key>` | string | Sync state and other meta values |
| `list:<kind>:<source>:tmp:<uuid>` | set | Temporary build of a replace; expires after 1 hour, deleted on failure |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.store` | `string` | `'MemoryEmailVerificationStore'` | `'RedisEmailVerificationStore'` | Selects this store |
| `emailVerification.redis` | `RedisOptions` | `{}` | Any ioredis option | Passed to `new Redis()`; `keyPrefix` defaults to `ev:` |

```ts
export default {
  emailVerification: {
    store: 'RedisEmailVerificationStore',
    // Sentinel needs no code: ioredis reads it from the options.
    redis: { sentinels: [{ host: 'sentinel-1', port: 26379 }, { host: 'sentinel-2', port: 26379 }], name: 'cache', keyPrefix: 'shop:ev:' },
  },
};
```

## Important behaviour

- **No Redis Cluster.** Use a single node or Sentinel.
- A store failure is not fatal for checks: `EmailVerification` logs it and runs the verifier live.
- `loadLists()` reads each set with `SMEMBERS`. It is not one atomic snapshot across sources, but each source is consistent.
- `keyPrefix` isolates apps that share a Redis; give each app its own.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Store | `EmailVerificationStore`, singleton, by class name | `RedisEmailVerificationStore` | Memory, ORM, DynamoDB | Subclass and override `createClient()` or `clientOptions()` to change the connection; decorate with `@Injectable(EmailVerificationStore)` and set `emailVerification.store` to the subclass name. See [custom stores](../email-verification/07-custom-verifiers-and-stores.md#custom-emailverificationstore). |

## Related

- [Choosing a store](../email-verification/06-choosing-a-store.md)
- [ioredis options](https://github.com/redis/ioredis#connect-to-redis)
