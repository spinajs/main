# Temporary files

S3 cannot append, unzip or hand out a local path, so `fsS3` downloads objects into a local temporary filesystem named `fs-temp-s3` and works on the copy. The package config ships one.

## How it works

`fsS3.TempFs` is a `@FileSystem('fs-temp-s3')` property: a getter that calls `getFs('fs-temp-s3')` on every access. It throws `ResolveException` when no provider of that name is registered, so a missing temp filesystem surfaces at the first operation that needs it, not at boot.

`fsS3.download(path)`, the base of the other flows:

1. `TempFs.tmppath(extname(path))` picks a local path that keeps the object's extension.
2. `TempFs.writeStream(tmpPath)` opens a local write stream.
3. `S3.send(GetObjectCommand)` fetches the object; its body is piped into the stream.
4. The promise resolves with the local path on the stream's `close`. It rejects with `IOFail` when the body is not a `Readable`, and with the SDK error when the key is missing.

Operations built on it:

| Method | Flow | Local copy |
| --- | --- | --- |
| `download(path)` | steps above | kept; the caller owns it, or `fs-temp-s3` cleanup removes it |
| `read(path, encoding?)` | `download()`, `TempFs.read()` | deleted after reading |
| `append(path, data, encoding?)` | `download()`, `TempFs.append()`, `upload()` | deleted in `finally` |
| `copy(path, dest, dstFs)` | `download()`, `dstFs.upload()` | deleted in `finally` |
| `unzip(srcPath, destPath?, dstFs?)` | `download()`, `TempFs.unzip(local, destPath, dstFs ?? TempFs)` | archive deleted in `finally`; the extracted files stay |
| `zip(paths, dstFs?, dstFile?)` | `download()` per entry, `TempFs.zip(entries, dstFs ?? TempFs, dstFile)` | downloads deleted in `finally`; the archive stays |

`zip()` accepts a key or a `[key, entryName]` pair per entry. A plain key is passed as the entry name.

## Configuration

`fs-temp-s3` is an ordinary `fsTemp` provider from `@spinajs/fs`, wrapping a local `fsNative` provider. The keys below are the ones `fsS3` relies on; the full list is in the [`@spinajs/fs` docs](../fs/README.md).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers[name='fs-temp-s3'].service` | `string` | none | `'fsTemp'` | The name `fs-temp-s3` is fixed in `fsS3`. |
| `fs.providers[name='fs-temp-s3'].provider` | `string` | none | name of a **local** provider | Backend holding the files. `download()` returns its paths as local paths. |
| `fs.providers[name='fs-temp-s3'].cleanup` | `boolean` | `undefined` (off) | `true`, `false` | Deletes old temp files on a schedule. |
| `fs.providers[name='fs-temp-s3'].cleanupInterval` | `number` (ms) | 10 minutes | positive integer | Cleanup interval. |
| `fs.providers[name='fs-temp-s3'].maxFileAge` | `number` (s) | 1 hour | positive integer | Age after which a temp file is deleted. |

```ts
fs: {
  providers: [
    { service: 'fsNative', name: 'fs-temp-s3-local', basePath: '/var/app/temp-s3' },
    {
      service: 'fsTemp',
      name: 'fs-temp-s3',
      provider: 'fs-temp-s3-local',
      cleanup: true,
      cleanupInterval: 3600 * 1000, // ms: every hour
      maxFileAge: 24 * 3600, // s: one day
    },
  ],
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fs-temp-s3` | named provider in `__file_provider_instance__`, created by `fsService` from config; read lazily by `fsS3` on each access | the shipped `fsTemp` over `fsNative` (`fs-temp-s3-local`) | any `fsTemp` cleanup strategy (`cleanupStrategy`), any local backend | Change the `fs-temp-s3` entry. To use a different name per S3 provider, redeclare `TempFs` with `@FileSystem('<name>')` in an `fsS3` subclass. |

### Temporary filesystem: one per bucket

Give a large-media bucket its own temp disk, so its downloads do not fill the volume the other buckets use. Redeclare `TempFs` in a subclass; `@FileSystem()` defines the getter on the subclass prototype, which shadows the parent's.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { FileSystem, fs } from '@spinajs/fs';
import { fsS3 } from '@spinajs/fs-s3';
import _ from 'lodash';

@Injectable('fs')
@PerInstanceCheck()
export class fsS3Media extends fsS3 {
  @FileSystem('fs-temp-media')
  protected TempFs: fs;
}

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      fs: {
        providers: [
          { service: 'fsS3Media', name: 'media', bucket: 'acme-media' },
          { service: 'fsNative', name: 'fs-temp-media-disk', basePath: '/mnt/scratch/media' },
          { service: 'fsTemp', name: 'fs-temp-media', provider: 'fs-temp-media-disk', cleanup: true, cleanupInterval: 600 * 1000, maxFileAge: 3600 },
        ],
      },
    });
  }
}
```

## Important behaviour

- **A default is shipped.** The package config declares `fs-temp-s3-local` (`fsNative` at `<os temp dir>/spinajs-fs-temp-s3`) and `fs-temp-s3` over it, with hourly cleanup and a one-day `maxFileAge`. A provider with the same name in your application config replaces it.
- **The backend must be local.** `download()` returns the temp path as a local path, and `upload()` reads it with `createReadStream`. An S3 or FTP backend breaks every flow on this page.
- **`download()` leaves the file behind.** Delete it with `TempFs.rm()` when done, or rely on cleanup with a `maxFileAge` above your longest processing time.
- **`append()` re-uploads the whole object.** It costs a full download and upload per call, and it replaces the object's metadata with freshly computed file info.
- **`unzip()` and `zip()` without `dstFs` write to `fs-temp-s3`.** The results are temp files and get cleaned up; pass a `dstFs` to keep them.
- **Extracting straight into S3 is not supported.** `unzip()` needs a local-path destination filesystem.

## Best practices

- Put `fs-temp-s3-local` on a volume sized for the largest object you `read`, `append` or `zip`.
- Set `maxFileAge` above the longest job that holds a downloaded file; cleanup deletes files still in use.
- Use `readStream()` instead of `read()` when the object does not need a local file.

## Examples

### Extract an uploaded theme package to local disk

```ts sample
import { getFs } from '@spinajs/fs';
import '@spinajs/fs-s3';

export async function installTheme(themeKey: string): Promise<string> {
  const uploads = getFs('uploads');
  const themes = getFs('themes');

  // downloads the archive to fs-temp-s3, extracts it onto the local 'themes' provider
  return uploads.unzip(themeKey, 'current', themes);
}
```

### Bundle a customer's invoices for download

```ts sample
import { getFs } from '@spinajs/fs';
import '@spinajs/fs-s3';

export async function bundleInvoices(customerId: string, invoiceNos: string[]) {
  const invoices = getFs('invoices');
  const exports = getFs('exports');

  const entries = invoiceNos.map((no) => [`${customerId}/${no}.pdf`, `${no}.pdf`]);
  return invoices.zip(entries, exports, `${customerId}-invoices.zip`);
}
```

## Related

- [S3 file provider](01-s3-file-provider.md): the operations listed above.
- [Custom S3 provider](05-custom-s3-provider.md): more `fsS3` subclass examples.
- [`@spinajs/fs`](../fs/README.md): `fsTemp`, `fsNative` and temp cleanup strategies.
