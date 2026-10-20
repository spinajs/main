# Provider path resolution

The string an `fs-path://` value turns into comes from the named provider's `resolvePath()`. Change it there and every `fs-path://` value for that provider follows, together with every file operation of the provider.

## How it works

1. `FsBootsrapper.bootstrap()` (in `@spinajs/fs`) registers a factory under `'__file_provider__'`. It looks the name up in the `'__file_provider_instance__'` map.
2. `fsService.resolve()` creates one instance per `fs.providers[]` entry, picking the class registered under `'fs'` whose name equals `service`, and adds it to the map under `name`.
3. `ConfigurationFsPathProtocol` calls `getFs(name)`, which resolves `'__file_provider__'` with `[name]`:
   - no map yet (`fsService` not resolved) throws `ResolveException`;
   - an unknown name throws `ResolveException`;
   - an empty name returns `undefined`.
4. It calls `provider.resolvePath(path)` and returns the result.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| File provider | class registered under `'fs'`; one instance per provider `name` (`@PerInstanceCheck()`); created by `fsService` | `fsNative` | `fsTemp` (delegates to its backing provider); `fsS3`, `fsFTP`, `fsOneDrive` | Subclass a provider, override `resolvePath()`, register it with `@Injectable('fs')`, and name its class in `fs.providers[].service` |
| Provider lookup | `'__file_provider__'` factory, registered by `FsBootsrapper.bootstrap()` | the `@spinajs/fs` factory | none | Owned by `@spinajs/fs`; configure providers instead of replacing it |

What each shipped provider returns for `fs-path://<name>/<path>`:

| Provider | `resolvePath(path)` result |
| --- | --- |
| `fsNative` with `basePath` | `join(basePath, path)`; throws `IOFail` when the result escapes `basePath` (value becomes `null`) |
| `fsNative` without `basePath` | `path` unchanged, relative to the process working directory |
| `fsTemp` | whatever its backing provider returns |
| `fsS3`, `fsFTP` | throws `MethodNotImplemented` for a relative path; `fs-path://` always passes a relative path, so the value is `null` |
| `fsOneDrive` | throws `MethodNotImplemented`; the value is `null` |

### File provider: custom implementation

Override `resolvePath()` when a provider's paths need a different layout, for example one folder per deployed release. Keep calling `super.resolvePath()` so the `basePath` sandbox check still runs.

Register the class before `fsService` is resolved: `fsService` collects the classes under `'fs'` when it creates the providers.

```ts sample
import { join } from 'node:path';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsNative, IFsLocalOptions } from '@spinajs/fs';

// fs-path://fs-cache/thumbnails -> <basePath>/<APP_RELEASE>/thumbnails
@Injectable('fs')
@PerInstanceCheck()
export class fsReleaseNative extends fsNative<IFsLocalOptions> {
  public resolvePath(path: string): string {
    return super.resolvePath(join(process.env.APP_RELEASE ?? 'dev', path));
  }
}
```

Select it in configuration:

```ts sample
const config = {
  fs: {
    defaultProvider: 'fs-cache',
    providers: [{ service: 'fsReleaseNative', name: 'fs-cache', basePath: '/var/cache/shop' }],
  },
  thumbnails: {
    dir: 'fs-path://fs-cache/thumbnails',
  },
};

export default config;
```

## Important behaviour

- **One resolver for config and file I/O.** `fsNative` routes `read()`, `write()` and the rest through `resolvePath()`. A custom `resolvePath()` moves real files too, not only the config value.
- **The result is cached.** The `ConfigVar` keeps the first string. A `resolvePath()` that depends on state changing at run time is read once.
- **Errors become `null`.** Anything `resolvePath()` throws is logged by the protocol as a warning and the value is retried on the next read.

## Best practices

- Use `fsNative` providers with an explicit `basePath` for `fs-path://` targets, so the result is absolute.
- Resolve the same location in code with `getFs('fs-data').resolvePath('invoices')` when a component has no config key for it; both give the same string.

## Examples

### Resolve the same folder from code and from config

```ts sample
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService, getFs } from '@spinajs/fs';

export async function archiveDirsMatch(): Promise<boolean> {
  const config = await DI.resolve(Configuration);
  await DI.resolve(fsService);

  const fromConfig = config.get<string | null>('invoices.archiveDir');
  const fromProvider = getFs('fs-data').resolvePath('invoices');

  return fromConfig === fromProvider;
}
```

## Related

- [`fs-path://` values](01-fs-path-values.md): parsing and failure modes.
- [Replacing or extending the protocol](02-replacing-or-extending-the-protocol.md): change parsing instead of the provider.
- [`@spinajs/fs`](../fs/README.md): providers, `fsService`, `FsBootsrapper` and `getFs()`.
