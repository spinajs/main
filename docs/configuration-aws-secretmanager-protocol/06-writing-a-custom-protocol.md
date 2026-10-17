# Writing a custom protocol

A protocol is a class that extends `ConfigVarProtocol` from `@spinajs/configuration-common` and is registered under it in DI. This package's helpers give a new protocol the same path syntax, fallbacks, caching and warnings as `aws-secrets://`.

## How it works

1. Extend `ConfigVarProtocol` and implement `get Protocol()` (the scheme with `://`) and `getVar(path, configuration)`.
2. Decorate the class with `@Singleton()` and `@Injectable(ConfigVarProtocol)`; DI appends it to the `ConfigVarProtocol` list when the module is evaluated.
3. `FrameworkConfiguration.loadProtocolVars()` resolves `Array.ofType(ConfigVarProtocol)` and maps each instance by `Protocol`.
4. For each config string `<scheme>://<rest>` it calls `getVar(rest, rawConfig)`. The return value replaces the string; a thrown error is logged and the string stays.
5. Inside `getVar()`, the helpers below handle parsing, caching and fallbacks.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConfigVarProtocol` | abstract class from `@spinajs/configuration-common`; resolved as `Array.ofType(ConfigVarProtocol)` on every `Configuration.load()` | none | `AwsSecretsManagerVarProtocol` (`aws-secrets://`), `AwsParameterStoreVarProtocol` (`aws-parameters://`), protocols of other packages such as [`@spinajs/configuration-fs-protocol`](../configuration-fs-protocol/README.md) | Extend it and register with `@Injectable(ConfigVarProtocol)` before `Configuration` is resolved |

`ConfigVarProtocol` contract:

| Member | Meaning |
| --- | --- |
| `get Protocol(): string` | Scheme including `://`. Must match `[a-zA-Z0-9-]+://`; the lookup is case-sensitive. `http://`, `https://`, `ws://`, `wss://`, `ftp://`, `ftps://`, `file://`, `data://`, `blob://` are never routed to a protocol. |
| `getVar(path, configuration)` | `path` is everything after the scheme. `configuration` is the raw config object being loaded. Returns the new value. |
| `resolve()` / `dispose()` | From `AsyncService`; DI awaits `resolve()` when it creates the singleton. |

Helpers exported by this package:

| Helper | Signature | Use |
| --- | --- | --- |
| `parseAwsPath` | `(raw: string) => ParsedAwsPath` | Split `id?query#json.path` into `{ id, params: URLSearchParams, jsonPath? }`. Splits on the first `#`, then the first `?`; case is kept. |
| `warnUnknownParams` | `(params, allowed: string[], source, id) => void` | Log each query key not in `allowed`. |
| `parseBoolParam` | `(params, key, fallback: boolean, source) => boolean` | Read `true`/`false`; log and use `fallback` for other values. |
| `resolveFallback` | `(params, source, id, err) => FallbackResult` | Apply `?default=` / `?optional=true` to a failed fetch. |
| `extractValue` | `(value: string \| Buffer \| undefined, jsonPath?) => unknown` | Parse JSON and read a dot path; throws on invalid JSON. |
| `assignNested` | `(target, keys: string[], value) => void` | Write `value` at a nested key, creating objects on the way. |
| `TtlCache`, `DEFAULT_CACHE_TTL` | class, `300000` | TTL cache with in-flight de-duplication. See [Caching](04-caching.md). |
| `createSdkLogger` | `(source: string) => { trace, debug, info, warn, error }` | AWS SDK `logger` that writes to `InternalLogger`. |

### ConfigVarProtocol: HashiCorp Vault KV v2

Read secrets from Vault with the same syntax as the AWS protocols: `vault://secret/data/billing?default=dev#password`.

```ts sample
import { ConfigVarProtocol } from '@spinajs/configuration-common';
import {
  DEFAULT_CACHE_TTL,
  extractValue,
  parseAwsPath,
  resolveFallback,
  TtlCache,
  warnUnknownParams,
} from '@spinajs/configuration-aws-secretmanager-protocol';
import { Injectable, Singleton } from '@spinajs/di';

interface VaultOptions {
  address?: string;
  token?: string;
  cacheTtl?: number;
}

@Singleton()
@Injectable(ConfigVarProtocol)
export class VaultVarProtocol extends ConfigVarProtocol {
  protected cache = new TtlCache();

  get Protocol(): string {
    return 'vault://';
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public async getVar(path: string, configuration: any): Promise<string | number | boolean | object | undefined> {
    const options: VaultOptions = configuration?.vault ?? {};
    const { id, params, jsonPath } = parseAwsPath(path);
    warnUnknownParams(params, ['default', 'optional'], 'VaultVarProtocol', id);

    const ttl = typeof options.cacheTtl === 'number' ? options.cacheTtl : DEFAULT_CACHE_TTL;

    let secret: string;
    try {
      secret = (await this.cache.resolve(id, ttl, async () => {
        const response = await fetch(`${options.address}/v1/${id}`, {
          headers: { 'X-Vault-Token': options.token ?? '' },
        });
        if (!response.ok) {
          throw new Error(`Vault returned ${response.status} for ${id}`);
        }
        const body = (await response.json()) as { data: { data: unknown } };
        return JSON.stringify(body.data.data);
      })) as string;
    } catch (err) {
      const fallback = resolveFallback(params, 'VaultVarProtocol', id, err);
      if (fallback.handled) {
        return fallback.value;
      }
      throw err;
    }

    return jsonPath ? (extractValue(secret, jsonPath) as string | number | boolean | object | undefined) : secret;
  }
}
```

Use it in a config class:

```ts
vault: { address: 'https://vault.internal:8200', token: process.env.VAULT_TOKEN, cacheTtl: 60_000 },
db: { password: 'vault://secret/data/billing/db?default=postgres#password' },
```

## Important behaviour

- Strings of one object resolve in parallel, nested objects after them. Do not read a value that another protocol resolves (e.g. `vault.token: 'aws-secrets://...'`) from inside `getVar()`: it may still be the raw string.
- A scheme no protocol claims logs `Protocol <scheme> used in configuration is not registered.` and leaves the string.
- Two protocols with the same `Protocol` string: the later one in the DI list wins.
- `getVar()` is called once per config string per `load()`. Without a cache, ten references mean ten requests.
- Returning `undefined` stores `undefined`; the AWS protocols return `''` for a missing value instead.

## Best practices

- Reuse `parseAwsPath()` and `resolveFallback()` so `?default=`, `?optional=true` and `#key` mean the same in every protocol of your app.
- Call `warnUnknownParams()` with the full list of keys you read; typos then show up in the log.
- Read the protocol's own settings from a dedicated config key (`vault`, `aws.secretsManager`) with literal values.
- Expose `clearCache()` like the shipped protocols; tests and rotation code call it on every `ConfigVarProtocol`.

## Patterns and antipatterns

```ts
// Don't: throw away the error and return undefined; the key silently becomes undefined
public async getVar(path: string) {
  try {
    return await this.fetchSecret(path);
  } catch {
    return undefined;
  }
}

// Do: let the caller opt in to a fallback, otherwise rethrow so the failure is logged
public async getVar(path: string) {
  const { id, params } = parseAwsPath(path);
  try {
    return await this.fetchSecret(id);
  } catch (err) {
    const fallback = resolveFallback(params, 'VaultVarProtocol', id, err);
    if (fallback.handled) {
      return fallback.value;
    }
    throw err;
  }
}
```

## Examples

### Read a value from an environment variable holding JSON

```ts sample
import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { extractValue, parseAwsPath, resolveFallback, warnUnknownParams } from '@spinajs/configuration-aws-secretmanager-protocol';
import { Injectable, Singleton } from '@spinajs/di';

// ECS injects a whole secret as one variable: DB_CREDENTIALS='{"username":"billing","password":"..."}'
// config: password: 'env-json://DB_CREDENTIALS#password'
@Singleton()
@Injectable(ConfigVarProtocol)
export class EnvJsonVarProtocol extends ConfigVarProtocol {
  get Protocol(): string {
    return 'env-json://';
  }

  public async getVar(path: string): Promise<string | number | boolean | object | undefined> {
    const { id, params, jsonPath } = parseAwsPath(path);
    warnUnknownParams(params, ['default', 'optional'], 'EnvJsonVarProtocol', id);

    try {
      const raw = process.env[id];
      if (raw === undefined) {
        throw new Error(`Environment variable ${id} is not set`);
      }
      return jsonPath ? (extractValue(raw, jsonPath) as string | number | boolean | object | undefined) : raw;
    } catch (err) {
      const fallback = resolveFallback(params, 'EnvJsonVarProtocol', id, err);
      if (fallback.handled) {
        return fallback.value;
      }
      throw err;
    }
  }
}
```

## Related

- [Replacing and extending the AWS protocols](05-replacing-and-extending-the-aws-protocols.md): change a shipped protocol instead of writing one.
- [Fallbacks and failures](03-fallbacks-and-failures.md): the semantics `resolveFallback()` gives your protocol.
- [`@spinajs/configuration-common`](../configuration-common/README.md): the `ConfigVarProtocol` contract.
- [`@spinajs/configuration`](../configuration/README.md): `loadProtocolVars()`, the caller of every protocol.
