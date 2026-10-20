# Caching

Each protocol instance keeps fetched values in a `TtlCache`. Repeated references to one secret cost one AWS call, and a config reload within the TTL costs none.

## How it works

1. `getVar()` builds a cache key from everything that changes the AWS answer:
   - Secrets Manager: secret id, `versionStage`, `versionId`.
   - Parameter Store: name (with any `:version`) and `withDecryption`; hierarchies use `tree <path> <withDecryption>`.
2. It reads the TTL from `aws.secretsManager.cacheTtl` or `aws.parameterStore.cacheTtl` on every call; a non-number gives `DEFAULT_CACHE_TTL` (5 minutes).
3. `TtlCache.resolve(key, ttl, factory)` returns the stored value when `ttl > 0` and the entry has not expired.
4. Otherwise, when a fetch for the key is already running, it returns that same promise.
5. Otherwise it calls `factory()`. On success, and when `ttl > 0`, it stores the value with `expiresAt = now() + ttl`. A failure is not stored.
6. The JSON path, `StringList` split and base64 conversion run after the cache, so one cached value serves every `#key` of a secret.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `aws.secretsManager.cacheTtl` | number (ms) | `300000` | any number; `<= 0` disables storing | TTL of Secrets Manager values. |
| `aws.parameterStore.cacheTtl` | number (ms) | `300000` | any number; `<= 0` disables storing | TTL of Parameter Store values and trees. |

```ts
aws: {
  secretsManager: { region: 'eu-central-1', cacheTtl: 60_000 },
  parameterStore: { region: 'eu-central-1', cacheTtl: 0 },
},
```

`cacheTtl: 0` still de-duplicates concurrent fetches inside one load.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TtlCache` | not in DI; one per protocol instance in the `protected cache` field, so it lives as long as the protocol singleton | `new TtlCache()` with `Date.now` | `new TtlCache(clock)` | Override `cache` in a protocol subclass; use it in your own protocol |
| `clearCache()` | public method on both protocols | drops all entries and in-flight references | - | Call before `Configuration.load()` to force fresh values |
| `DEFAULT_CACHE_TTL` | exported constant | `300000` | - | Use as the default TTL in a custom protocol |

`TtlCache` API:

| Member | Meaning |
| --- | --- |
| `constructor(now?: () => number)` | Clock in ms, `Date.now` by default. Inject a fake clock in tests. |
| `resolve(key, ttl, factory): Promise<unknown>` | Cached value, shared in-flight promise, or a new `factory()` call. |
| `clear(): void` | Drops entries and in-flight references. |

### TtlCache: custom clock in a subclass

Replace the `cache` field when you want a different clock or a separate cache per subclass. The field is created per instance, so the override takes effect from construction.

```ts sample
import { AwsSecretsManagerVarProtocol, TtlCache } from '@spinajs/configuration-aws-secretmanager-protocol';
import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';

export const testClock = { now: 0 };

@Singleton()
@Injectable(ConfigVarProtocol)
export class FakeClockSecretsProtocol extends AwsSecretsManagerVarProtocol {
  protected cache = new TtlCache(() => testClock.now);
}

DI.unregister(AwsSecretsManagerVarProtocol);
```

## Important behaviour

- The cache belongs to the protocol singleton, not to `Configuration`. `DI.uncache(Configuration)` followed by a new resolve still reads cached values.
- Within a TTL, a rotated secret is not seen by a `Configuration.load()`. Call `clearCache()` first.
- Entries never shrink on their own: an expired entry stays in memory until it is refreshed or `clear()` runs. The number of entries is bounded by the distinct ids in your config.
- `clear()` during a running fetch does not cancel it; when that fetch finishes it stores its value again.
- Two keys that differ only in fallback (`?default=`, `?optional=`) or JSON path share one entry.

## Best practices

- Keep the default TTL for services that reload config rarely; set `cacheTtl: 0` for a process that reloads on purpose to pick up rotations.
- In tests, call `clearCache()` on every `ConfigVarProtocol` in `afterEach`, because the singletons outlive each `Configuration`.

## Patterns and antipatterns

```ts
// Don't: reload expecting the rotated password, while the 5 minute cache still holds the old one
await config.load();

// Do: clear the protocol caches, then reload
const protocols = await DI.resolve(Array.ofType(ConfigVarProtocol));
protocols.forEach((p) => (p as { clearCache?: () => void }).clearCache?.());
await config.load();
```

## Examples

### Pick up a rotated database password

```ts sample
import { AwsSecretsManagerVarProtocol } from '@spinajs/configuration-aws-secretmanager-protocol';
import { Configuration, ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';

export async function reloadAfterRotation(): Promise<string> {
  const protocols = await DI.resolve(Array.ofType(ConfigVarProtocol));
  protocols
    .filter((p): p is AwsSecretsManagerVarProtocol => p instanceof AwsSecretsManagerVarProtocol)
    .forEach((p) => p.clearCache());

  const config = await DI.resolve<Configuration>(Configuration);
  await config.load();
  return config.get<string>('db.password');
}
```

### Cache an API token in your own code

```ts sample
import { TtlCache } from '@spinajs/configuration-aws-secretmanager-protocol';

const tokens = new TtlCache();

async function requestPartnerToken(): Promise<string> {
  const response = await fetch('https://auth.partner.example/token', { method: 'POST' });
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

export async function partnerToken(): Promise<string> {
  // ten parallel callers share one request; the token is reused for 50 minutes
  return (await tokens.resolve('partner-api', 50 * 60 * 1000, requestPartnerToken)) as string;
}
```

## Related

- [Fallbacks and failures](03-fallbacks-and-failures.md): failures bypass the cache.
- [Replacing and extending the AWS protocols](05-replacing-and-extending-the-aws-protocols.md): other overrides of a protocol subclass.
- [Writing a custom protocol](06-writing-a-custom-protocol.md): `TtlCache` in a new protocol.
