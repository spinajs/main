# Local provider

`fsNative` stores files on local disk under a base directory. Every path you pass is resolved inside that directory, and a path that escapes it throws. Use it for application data, uploads and as the backend of a [temp file system](04-temp-file-system.md).

## How it works

1. `fsService` creates `fsNative` with the provider entry as `Options`. Missing options throw `IOFail`.
2. `fsNative.resolve()` turns a relative `basePath` into an absolute one (`path.resolve()` against `cwd`).
3. It creates the base directory with its parents when it is missing, and logs a warning.
4. Each call resolves its path with `resolvePath()`:
   - no `basePath`: the path is returned unchanged;
   - an absolute path inside `basePath`: returned unchanged;
   - an absolute path with a drive letter or UNC root outside `basePath`: throws `IOFail` (`is outside of filesystem base path`);
   - any other path, including `/x` and `\x`: joined to `basePath`; a result outside `basePath` (eg. `../../etc/passwd`) throws `IOFail` (`escapes filesystem base path`).
5. The node `fs` call runs, and failures are wrapped in `IOFail` with the original error as `inner`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers[].service` | `string` | | `fsNative` | Selects this provider. |
| `fs.providers[].name` | `string` | required | | Provider name. |
| `fs.providers[].basePath` | `string` | unset | absolute or `cwd`-relative path | Root of the provider. Without it there is **no** sandbox and paths go to node `fs` as given. |

```ts
{ service: 'fsNative', name: 'documents', basePath: '/var/app/documents' }
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fsNative<T extends IFsLocalOptions>` | `'fs'`, `PerInstanceCheck` per `name` | `fsNative` | `fsS3`, `fsFTP`, `fsOneDrive` (other packages), your own [custom provider](06-custom-providers.md) | Subclass it, register with `@Injectable('fs')` and `@PerInstanceCheck()`, then set `service` to the subclass name. |

### Extending `fsNative`

Subclass `fsNative` when local storage fits and you need one more behaviour. The type parameter `T` lets the subclass add its own options.

| Member | Override to |
| --- | --- |
| `resolvePath(path)` | Change how paths map to disk. Keep the sandbox checks. |
| `toStatEntry(stats)` | Change how node `Stats` map to `IStat`, eg. fill `Version` or `AdditionalData`. |
| `_rename(old, new)` | Replace the native rename used by `move()` and `rename()`. |
| `zipEntrySource(entry)` / `zipEntryName(entry)` | Change how zip entries map to source paths and names. |
| `assertSourcesExist(paths)` / `addZipEntries(archive, paths)` | Change zip validation and the entries added. |
| `buildZipResult(fs, outFile)` | Change the returned `IZipResult`. |
| `signedUrl?(path, opts)` | Add public URLs; `fsNative` has none. |
| `resolve()` | Add boot work. Call `super.resolve()` first. |

```ts sample
import { createHmac } from 'crypto';
import { DateTime } from 'luxon';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsNative, fsService, getFs, IFsLocalOptions, IStat } from '@spinajs/fs';
import { Stats } from 'fs';

interface IPublicFsOptions extends IFsLocalOptions {
  publicUrl: string;
  urlSecret: string;
}

// config: { service: 'PublicLocalFs', name: 'downloads', basePath: './data/downloads',
//           publicUrl: 'https://example.com/files', urlSecret: 'change-me' }
@Injectable('fs')
@PerInstanceCheck()
export class PublicLocalFs extends fsNative<IPublicFsOptions> {
  public async signedUrl(path: string, opts?: { until?: DateTime; disposition?: string }): Promise<string> {
    const expires = (opts?.until ?? DateTime.now().plus({ hours: 1 })).toUnixInteger();
    const signature = createHmac('sha256', this.Options.urlSecret).update(`${path}:${expires}`).digest('hex');

    return `${this.Options.publicUrl}/${encodeURI(path)}?expires=${expires}&signature=${signature}`;
  }

  protected toStatEntry(result: Stats): IStat {
    return { ...super.toStatEntry(result), Version: `${result.mtimeMs}-${result.size}` };
  }
}

export async function shareInvoice(invoiceNumber: string): Promise<string> {
  await DI.resolve(fsService);

  const downloads = getFs('downloads');
  return downloads.signedUrl!(`invoices/${invoiceNumber}.pdf`, { until: DateTime.now().plus({ days: 7 }) });
}
```

Register the subclass before `fsService` resolves: importing the module runs `@Injectable('fs')`.

## Important behaviour

- `stat().CreationTime` comes from `birthtime`, or from `mtime` when the file system reports no birth time (epoch 0). `ctime` is not used.
- `stat()` leaves `Version` and `AdditionalData` unset.
- `list()` returns entry names from `readdir`, not full paths.
- `read()` without `encoding` returns a `Buffer`.
- `readStream()` throws `IOFail` for a missing file before it opens the stream. Later read errors arrive as stream `error` events.
- `rm()` deletes recursively, ignores a missing path, and retries 3 times, 1 second apart. Its errors are **not** wrapped in `IOFail`.
- `download()` returns the resolved local path and copies nothing.
- `tmppath()` returns an absolute path under `basePath`. Without `basePath` it throws a `TypeError` from `path.join()`.
- `unzip()` reports a source read error as `IOFail` instead of crashing the process.

## Best practices

- Always set `basePath`. It is the only thing that keeps a user-supplied path from reaching any file on the host.
- Pass user input as relative paths. An absolute path inside `basePath` is accepted unchanged, and one outside it throws.
- Give each concern its own provider (`uploads`, `exports`) with its own `basePath`, so a bug in one cannot touch the other's files.

## Patterns and antipatterns

```ts
// Don't: no basePath, so '../../etc/passwd' from a request reaches the host file system
{ service: 'fsNative', name: 'uploads' }

// Do: sandbox it
{ service: 'fsNative', name: 'uploads', basePath: './data/uploads' }
```

## Examples

### Reject a path that leaves the upload directory

```ts sample
import { IOFail } from '@spinajs/exceptions';
import { getFs } from '@spinajs/fs';

export async function readUserFile(requestedPath: string): Promise<Buffer | null> {
  const uploads = getFs('uploads');

  try {
    return (await uploads.read(requestedPath)) as Buffer;
  } catch (err) {
    if (err instanceof IOFail) {
      return null;
    }
    throw err;
  }
}
```

## Related

- [File operations](02-file-operations.md): the full provider API.
- [Custom providers](06-custom-providers.md): implementing `fs` from scratch.
- [Temp file system](04-temp-file-system.md): `fsNative` as a temp backend.
