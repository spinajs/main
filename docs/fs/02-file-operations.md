# File operations

Every provider exposes the same API, defined by the abstract `fs` class. Paths are relative to the provider's root, so code that writes `invoices/42.pdf` works the same on local disk, S3 or FTP.

You reach the API in four ways: methods on a provider instance, static methods on `fs` taking `URI`s, helper functions taking a provider name, and `_`-prefixed functional wrappers.

## How it works

1. You get a provider: `getFs('documents')`, `provider()` for the default one, `@FileSystem()` or `new URI('fs://documents/...')`. See [Providers and configuration](01-providers-and-configuration.md#getting-a-provider).
2. You call an instance method, eg. `documents.write('a.txt', 'hello')`.
3. The base `fs` class normalises every path (see [Important behaviour](#important-behaviour)) and runs the registered [middlewares](07-middlewares.md) before the provider touches anything.
4. The provider runs its protected `doX` hook against its backend. `fsNative` resolves the path inside its `basePath` first and wraps failures in `IOFail`. See [Local provider](03-local-provider.md).
5. Cross-provider calls (`copy`, `move`, `zip`, `unzip` with a destination `fs`) end in `dstFs.upload(localPath, dest)` or `dstFs.writeStream(...)` on the destination.

## Instance API

| Method | Returns | Meaning |
| --- | --- | --- |
| `read(path, encoding?)` | `Promise<string \| Buffer>` | Whole file. A `Buffer` without `encoding`. |
| `readStream(path, encoding?)` | `Promise<NodeJS.ReadableStream>` | Read stream. |
| `write(path, data, encoding?)` | `Promise<void>` | Creates or overwrites a file. |
| `writeStream(path, encoding?)` | `Promise<WriteStream \| PassThrough>` | Write stream to a file. |
| `writeStream(path, readStream, encoding?)` | same | Pipes `readStream` into the file. |
| `append(path, data, encoding?)` | `Promise<void>` | Appends to a file. |
| `exists(path)` | `Promise<boolean>` | File or directory exists. |
| `dirExists(path)` / `isDir(path)` | `Promise<boolean>` | Path is an existing directory. |
| `stat(path)` | `Promise<IStat>` | `IsDirectory`, `IsFile`, `Size`, `CreationTime`, `ModifiedTime`, `AccessTime`, `Version`, `AdditionalData`. Fields a provider cannot supply stay `undefined`. |
| `list(path)` | `Promise<string[]>` | Entry names of a directory (names, not paths). |
| `mkdir(path)` | `Promise<void>` | Creates a directory with its parents. |
| `rm(path)` | `Promise<void>` | Deletes a file, or a directory with its content. |
| `copy(path, dest, dstFs?)` | `Promise<void>` | Copies a file or directory, into `dstFs` when given. |
| `move(oldPath, newPath, dstFs?)` | `Promise<void>` | Copies, then deletes the source. |
| `rename(oldPath, newPath)` | `Promise<void>` | Renames within the provider. |
| `upload(srcPath, destPath?, options?)` | `Promise<void>` | Copies a **local** file or directory into the provider. `destPath` defaults to the source base name. With `{ exclusive: true }` an existing `destPath` throws `ResourceDuplicated` instead of being overwritten. Middlewares see `options` as `ctx.args[1]` and run before the provider's existence test: [Middlewares](07-middlewares.md#important-behaviour). |
| `download(path)` | `Promise<string>` | Local path to the file. Local providers return the resolved path; remote ones download a copy first. |
| `resolvePath(path)` | `string` | Full local path. |
| `hash(path, algo?)` | `Promise<string>` | Hex digest from [`FileHasher`](09-file-hashing.md). Algorithm defaults to `fs.hasher.defaultAlgorithm` (`sha256`). |
| `metadata(path)` | `Promise<IFileInfo>` | Metadata from [`FileInfoService`](10-file-metadata.md). |
| `zip(paths, dstFs?, dstFile?)` | `Promise<IZipResult>` | Zips files and directories. See [Zip and unzip](#zip-and-unzip). |
| `unzip(srcPath, destPath?, dstFs?)` | `Promise<string>` | Extracts an archive, returns the destination path. |
| `tmpname(ext?)` | `string` | A UUID, with `ext` appended (`ext` includes the dot: `.pdf`). |
| `tmppath(ext?)` | `string` | `tmpname(ext)` inside the provider's root. |
| `signedUrl(path, { until?, disposition? })` | `Promise<string>` | Time-limited public URL. A base method that throws `MethodNotImplemented` on providers without signed URLs (`fsNative`, `fsTemp`). |
| `getSignedUrl(path, until?)` | `Promise<string>` | Alias of `signedUrl(path, { until })`. |
| `hasEntries(path)` | `Promise<boolean>` | Something lives under `path`: a non-empty directory, or on a key store such as S3 any key with that prefix. |
| `BasePath` | `string \| undefined` | The root that absolute paths are made relative to. `undefined` when the provider has none. |
| `Name` / `ServiceName` | `string` | The provider `name`. |

## Static API on `fs`

Static methods take `URI` objects and call the instance method on `uri.Fs` with `uri.Path`. They exist for every instance method except `metadata`, `tmpname` and `signedUrl`.

| Method | Note |
| --- | --- |
| `fs.copy(src, dest)`, `fs.move(src, dest)` | `dest.Fs` is passed as `dstFs`, so the URIs may name different providers. |
| `fs.rename(src, dest)` | `dest` is a `URI` or a plain path. |
| `fs.upload(srcPath, destPath)` | `srcPath` is a local path, `destPath` a `URI`. |
| `fs.zip(path, dstFile)` | `path` is one `URI` or an array; the first one's provider does the zipping. |
| `fs.unzip(srcPath, destPath)` | Extracts into `destPath.Fs`. |
| `fs.tmppath(fsName, ext?)` | Takes a provider name, not a `URI`. |

## Helper functions

Each helper resolves a provider with `provider(fileSystem)` and calls the instance method. `fileSystem` is a provider name, an `fs` instance, or omitted for `fs.defaultProvider`.

| Function | Delegates to |
| --- | --- |
| `read(path, encoding?, fileSystem?)` | `read` |
| `write(path, data, encoding?, fileSystem?)` | `write` |
| `append(path, data, encoding?, fileSystem?)` | `append` |
| `copy(src, dst, srcFs?, dstFs?)` | `copy`, with `dstFs` resolved by name |
| `move(src, dst, srcFs?, dstFs?)` | `move`, with `dstFs` resolved by name |
| `rename(oldPath, newPath, fileSystem?)` | `rename` |
| `rm(path, fileSystem?)` | `rm` |
| `mkdir(path, fileSystem?)` | `mkdir` |
| `list(path, fileSystem?)` | `list` |
| `stat(path, fileSystem?)` | `stat` |
| `dirExists(path, fileSystem?)` / `isDir(path, fileSystem?)` | `dirExists` / `isDir` |
| `download(path, fileSystem?)` | `download` |
| `upload(srcPath, dstPath?, fileSystem?)` | `upload` |
| `hash(path, algo?, fileSystem?)` | `hash` |
| `exists(path, fileSystem?)` | `exists`; **without** `fileSystem` it checks an absolute local path with node `access()`, not the default provider |
| `zip(srcPath[], dstName, srcFs?, dstFs?)` | `zip`; `srcFs` defaults to `fs-temp`, `dstFs` to `srcFs` |
| `unzip(srcPath, dstName, srcFs?)` | `unzip` into `srcFs`; `srcFs` defaults to `fs-temp` |
| `fileHash(path)` | `FileHasher.hash()` on an absolute local path, default algorithm |
| `fileInfo(path)` | `FileInfoService.getInfo()` on an absolute local path |
| `isOfType(path, extension)` / `isOfMimetype(path, mime)` | Detects the type from the content of a local file; throws `IOFail` on a mismatch or an unknown type. See [File metadata](10-file-metadata.md#file-type-checks). |
| `readFile(path, options?)` | node `readFile` on a local path, as a promise |

### Functional wrappers

`fp.ts` exports a `_`-prefixed wrapper for every helper: `_read`, `_write`, `_copy`, `_zip`, and so on. Most return the same promise as the helper. Five return a **function** you call later:

| Wrapper | Returns |
| --- | --- |
| `_fs(fileSystem)` | `() => fs \| undefined` |
| `_exists(path, fileSystem?)` | `() => Promise<boolean>` |
| `_isOfType(path, extension)` | `() => Promise<void>` |
| `_isOfMimetype(path, mimetype)` | `() => Promise<void>` |
| `_readFile(path, options?)` | `() => Promise<Buffer>` |

## Zip and unzip

- `paths` is a path, or an array of paths and `[sourcePath, entryName]` tuples.
- A plain path to a directory is added recursively; anything else is added as one file named after the **base name** of its path, or after `entryName` as given (folders included).
- Every source must exist. Otherwise `zip()` throws one `IOFail` listing all missing paths.
- `fsNative.zip()` writes to `dstFs`, or to the provider named `fs-temp` when you pass none. `fsTemp.zip()` writes to itself; `fsS3` and `fsFTP` write to their temp fs.
- `dstFile` defaults to `<uuid>.zip`.
- `IZipResult` gives `fs` (the destination), `asFilePath()`, `asStream(encoding?)`, `asBase64()` and `unlink()`. The first three read the local path, so they need a destination with local paths.
- `unlink()` returns a promise: `await` it.
- `unzip()` extracts into `dstFs` (or the same provider; `fsS3` and `fsFTP` use their temp fs) at `destPath`, or a new UUID directory, and returns its resolved path.

## Important behaviour

- Every action normalises its paths with `normalizeFsPath` against `fs.BasePath`, with or without middlewares. `..` above the root, a NUL byte and a drive or UNC path outside the base path throw `InvalidArgument`. See [Path normalisation](07-middlewares.md#path-normalisation).
- `fsNative.write()` and `writeStream()` do **not** create missing parent directories; `write()` throws `IOFail`. `copy()`, `move()` and `upload()` create them.
- `write()` flushes to disk (`fsync`) before it resolves.
- `rm()` does not fail on a missing path.
- `move()` across devices (`EXDEV`) falls back to copy and delete.
- `copy()` to another provider uploads the resolved local source path, so the source provider must have local paths.
- `writeStream(path, readStream)` destroys the write stream when the source stream errors.
- `upload(..., { exclusive: true })` is atomic in `fsNative` (`COPYFILE_EXCL`, single files only) and `fsS3` (`IfNoneMatch: '*'`). `fsFTP` checks `exists()` first, so two clients can still race. A provider that ignores `options` overwrites.

## Best practices

- Use `fs-temp` for intermediate files: `tmppath()` gives a unique name, and the cleanup strategy deletes what you forget.
- Pass `encoding` to `read()` when you want text; without it you get a `Buffer`.
- Call `mkdir()` on the parent before `write()` to a new directory.
- Call `unlink()` on an `IZipResult` once you sent the archive.

## Patterns and antipatterns

```ts
// Don't: exists() without a provider checks the process's local disk, not the default provider
const found = await exists('invoices/42.pdf');

// Do: name the provider
const found = await exists('invoices/42.pdf', 'documents');
```

```ts
// Don't: read the whole file into memory to copy it
const data = await source.read('video.mp4');
await target.write('video.mp4', data);

// Do: let the provider copy it
await source.copy('video.mp4', 'video.mp4', target);
```

## Examples

### Export orders as a zip archive

```ts sample
import { getFs } from '@spinajs/fs';

export async function exportOrders(orders: { Id: number; Total: number }[]): Promise<string> {
  const temp = getFs('fs-temp');
  const dir = temp.tmpname();

  await temp.mkdir(dir);
  await temp.write(`${dir}/orders.json`, JSON.stringify(orders), 'utf-8');
  await temp.write(`${dir}/summary.txt`, `${orders.length} orders`, 'utf-8');

  const archive = await temp.zip([dir]);
  const base64 = archive.asBase64();

  await archive.unlink();
  await temp.rm(dir);

  return base64;
}
```

### Stream an upload body into storage

```ts sample
import { getFs } from '@spinajs/fs';
import { Readable } from 'stream';

export async function storeUpload(body: Readable, fileName: string): Promise<number> {
  const uploads = getFs('uploads');
  await uploads.mkdir('incoming');

  const target = await uploads.writeStream(`incoming/${fileName}`, body);
  await new Promise<void>((resolve, reject) => {
    target.on('close', () => resolve());
    target.on('error', reject);
  });

  const info = await uploads.stat(`incoming/${fileName}`);
  return info.Size ?? 0;
}
```

### Use the default provider through helpers

```ts sample
import { list, read, write } from '@spinajs/fs';

export async function appendAuditLine(line: string): Promise<string[]> {
  const current = (await read('audit.log', 'utf-8')) as string;
  await write('audit.log', `${current}${line}\n`, 'utf-8');

  return list('/');
}
```

## Related

- [Providers and configuration](01-providers-and-configuration.md): how providers are created and found.
- [Local provider](03-local-provider.md): path rules and errors of `fsNative`.
- [Temp file system](04-temp-file-system.md): where `fs-temp` keeps its files.
