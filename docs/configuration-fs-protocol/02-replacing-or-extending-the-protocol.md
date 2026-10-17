# Replacing or extending the protocol

`ConfigurationFsPathProtocol` is an ordinary DI service under the `ConfigVarProtocol` token. Subclass it to change how `fs-path://` values parse or fail, unregister it to replace it, or register a sibling protocol (`fs-dir://`, ...) that reuses its resolver.

## How it works

1. `@Injectable(ConfigVarProtocol)` on a class registers it in the root container under `ConfigVarProtocol` and under itself. `@Singleton()` keeps one instance.
2. Each `FrameworkConfiguration.load()` resolves `DI.resolve(Array.ofType(ConfigVarProtocol))`, in registration order.
3. It builds a `Map` keyed by each instance's `Protocol`. When two protocols return the same prefix, the one registered **last** wins.
4. For each matching value it awaits `protocol.getVar(rest, rawConfig)`:
   - a plain value (string, number, object) replaces the config string at once;
   - a `ConfigVar` replaces it and is dereferenced on each read until it returns a truthy value;
   - a thrown error or rejected promise is logged as `Error loading configuration var for key ...` and the key keeps the raw `fs-path://...` string.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConfigurationFsPathProtocol` | `ConfigVarProtocol` (class list) and `ConfigurationFsPathProtocol`; singleton; registered by the decorators when the package is imported | `ConfigurationFsPathProtocol` | none shipped | Subclass and override `getVar()`; `DI.unregister(ConfigurationFsPathProtocol)` first to drop the default; or return another `Protocol` to add a sibling |
| `ConfigVarProtocol` | abstract base, extends `AsyncService`; every subclass registered under it is collected | `ConfigurationFsPathProtocol` (this package) | `AwsSecretsManagerVarProtocol`, `AwsParameterStoreVarProtocol` | Implement `Protocol` and `getVar()`; override `resolve()` for async set-up |
| `ConfigVar` | not in DI; a value wrapper returned from `getVar()` | the resolver closure in `ConfigurationFsPathProtocol.getVar()` | any closure | Wrap or replace the closure; return `null` to have it retried on the next read |

The `ConfigVarProtocol` contract:

| Member | Meaning |
| --- | --- |
| `get Protocol(): string` | Exact prefix, including `://`, matched case-sensitively |
| `getVar(path, configuration)` | `path` is the value without the prefix; `configuration` is the raw merged config object (no proxies, no other protocol values resolved yet) |
| `resolve()` | `AsyncService` hook, awaited when DI creates the instance, before the first `getVar()` |

### `ConfigurationFsPathProtocol`: custom implementation

Replace it when the default parsing or failure mode does not fit:

- The default splits at the last `/`, so `fs-path://fs-data/invoices/2026` fails. A subclass can split at the first `/`.
- The default turns every failure into `null`. A subclass can report a misspelled provider name at boot instead.

Override `getVar()` only. Keep returning a `ConfigVar`: `fsService` registers the providers after `Configuration` is resolved, so a resolver that runs inside `getVar()` always fails.

Register the replacement before `Configuration` is resolved. Call `DI.unregister(ConfigurationFsPathProtocol)` after the package is imported and before your class is declared, so the default is not collected at all.

```ts sample
import { ConfigVar, ConfigVarProtocol } from '@spinajs/configuration';
import { ConfigurationFsPathProtocol } from '@spinajs/configuration-fs-protocol';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { getFs } from '@spinajs/fs';

// the import above already registered the default protocol
DI.unregister(ConfigurationFsPathProtocol);

// fs-path://fs-data/invoices/2026 -> provider fs-data, path invoices/2026
@Singleton()
@Injectable(ConfigVarProtocol)
export class NestedFsPathProtocol extends ConfigurationFsPathProtocol {
  public async getVar(path: string): Promise<ConfigVar> {
    return new ConfigVar(() => {
      const slash = path.indexOf('/');
      if (slash <= 0) {
        return null;
      }

      try {
        return getFs(path.substring(0, slash)).resolvePath(path.substring(slash + 1));
      } catch {
        // providers are not registered yet: null is not cached, the next read retries
        return null;
      }
    });
  }
}
```

### Sibling protocol: reuse the resolver under another prefix

Return a different `Protocol` from a subclass and both protocols stay active. `super.getVar()` gives you the default resolver as a `ConfigVar` to wrap.

```ts sample
import { mkdirSync } from 'node:fs';
import { ConfigVar, ConfigVarProtocol } from '@spinajs/configuration';
import { ConfigurationFsPathProtocol } from '@spinajs/configuration-fs-protocol';
import { Injectable, Singleton } from '@spinajs/di';

// fs-dir://fs-data/uploads resolves like fs-path:// and creates the folder on first read
@Singleton()
@Injectable(ConfigVarProtocol)
export class FsDirProtocol extends ConfigurationFsPathProtocol {
  get Protocol(): string {
    return 'fs-dir://';
  }

  public async getVar(path: string): Promise<ConfigVar> {
    const location: ConfigVar = await super.getVar(path);

    return new ConfigVar(() => {
      const dir = location.get() as string | null;
      if (dir) {
        mkdirSync(dir, { recursive: true });
      }
      return dir;
    });
  }
}
```

## Important behaviour

- **Last registration wins.** A subclass that keeps `'fs-path://'` without `DI.unregister(ConfigurationFsPathProtocol)` still works, because a subclass module registers after the base it imports. The default instance is created anyway, and the outcome depends on import order. Unregister the default.
- **`getVar()` runs once per value per `load()`.** The second argument is the raw config. Values of other protocols are not resolved yet, and there is no proxy.
- **Throwing keeps the raw string.** A rejection from `getVar()` is logged at error level and does not fail the boot. Readers then get `'fs-path://...'`, not `null`.
- **`ConfigVar` caches truthy values only.** Return `null` (or `''`) for "not ready yet"; return a string only when it is final.
- **The resolver runs on the reading code path.** Keep it synchronous and cheap: `ConfigVar.get()` cannot await, and it runs on every read until it succeeds.

## Best practices

- Keep the `@Singleton()` and `@Injectable(ConfigVarProtocol)` pair on every subclass, so it is collected once.
- Import the module that declares your protocol before anything resolves `Configuration`. In a SpinaJS app, place it in a directory the app loads at start-up.
- Wrap `super.getVar()` instead of copying its parsing when you only add behaviour around the path.

## Patterns and antipatterns

```ts
// Don't: getVar() runs during Configuration.load(), before fsService registered providers;
// getFs() throws and the key keeps the raw 'fs-path://...' string
public async getVar(path: string) {
  return getFs(path.split('/')[0]).resolvePath(path.split('/')[1]);
}

// Do: defer the lookup to the first read
public async getVar(path: string) {
  return new ConfigVar(() => {
    try {
      return getFs(path.split('/')[0]).resolvePath(path.split('/')[1]);
    } catch {
      return null;
    }
  });
}
```

## Examples

### Report a misspelled provider name at boot

The second `getVar()` argument is the merged config, so the provider list is already there. A rejected `getVar()` logs an error naming the key, and the key keeps the raw string.

```ts sample
import { ConfigVar, ConfigVarProtocol } from '@spinajs/configuration';
import { ConfigurationFsPathProtocol } from '@spinajs/configuration-fs-protocol';
import { DI, Injectable, Singleton } from '@spinajs/di';

interface FsProvidersSection {
  fs?: { providers?: { name: string }[] };
}

DI.unregister(ConfigurationFsPathProtocol);

@Singleton()
@Injectable(ConfigVarProtocol)
export class CheckedFsPathProtocol extends ConfigurationFsPathProtocol {
  public async getVar(path: string, configuration?: FsProvidersSection): Promise<ConfigVar> {
    const name = path.substring(0, path.lastIndexOf('/'));
    const known = (configuration?.fs?.providers ?? []).map((p) => p.name);

    if (!known.includes(name)) {
      throw new Error(`fs-path provider '${name}' is not configured, known providers: ${known.join(', ')}`);
    }

    return super.getVar(path);
  }
}
```

## Related

- [`fs-path://` values](01-fs-path-values.md): the default resolver step by step.
- [Provider path resolution](03-provider-path-resolution.md): change the result without touching the protocol.
- [`@spinajs/configuration-common`](../configuration-common/README.md): `ConfigVarProtocol` and `ConfigVar`.
- [`@spinajs/di`](../di/README.md): `Injectable`, `Singleton`, `unregister` and `Array.ofType`.
