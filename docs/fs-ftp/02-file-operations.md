# File operations

What each `fs` method does on an `fsFTP` provider. The API is the abstract `fs` from `@spinajs/fs`; this page lists where FTP changes the outcome: the shared working directory, temp downloads, and the methods FTP cannot support.

## How it works

Every `fsFTP` instance owns one `basic-ftp` `Client` and one control connection. The connection has one current working directory, which methods change with `cd`.

1. A call such as `ftp.write('reports/2026/q3.csv', csv)` enters the `fsFTP` method.
2. Most methods first call `_restoreRootDir()`: it reads `pwd` and sends `cd ..` once per path segment until the connection is back at `/`.
3. They then call `_setWorkingDir(path)`, which sends `cd /<parent>` (or `cd .` for a file in the root), or `_ensureDir(path)`, which creates the parent directories with `Client.ensureDir()` first.
4. The FTP command runs against the file's base name: `uploadFrom`, `appendFrom`, `downloadTo` or `remove`.
5. Methods that need the bytes locally (`read()`, `copy()`, cross-provider `move()`, `zip()`, `unzip()`) first `download()` the file into the `fs-temp` provider and delete the temp copy afterwards.
6. `basic-ftp` errors (`FTPError` with the server's reply code, socket errors) reach the caller unchanged; `fsFTP` does not map them.

## Method reference

| Method | Steps on the server | Result |
| --- | --- | --- |
| `download(path)` | Root, `cd` to parent, `RETR` into `fs-temp` via `TempFs.writeStream(TempFs.tmppath())` | Absolute local temp path. The temp file has **no** extension. You delete it |
| `read(path, encoding)` | `download()`, `TempFs.read()`, `TempFs.rm()` | File content as `string` (with `encoding`) or `Buffer` |
| `readStream(path, encoding?)` | Root, `cd` to parent, starts `RETR` into a `PassThrough` without waiting | The `PassThrough`. A transfer error destroys it with that error |
| `write(path, data, encoding?)` | Root, `ensureDir` parent, `STOR` base name | Creates missing directories, overwrites an existing file |
| `append(path, data, encoding?)` | Root, `ensureDir` parent, `APPE` base name | Appends to the remote file; FTP servers create it when missing |
| `upload(localPath, destPath?)` | Root, `ensureDir` parent, `STOR` from the local file | `destPath` defaults to the base name of `localPath`, in the root |
| `writeStream(...)` | none | Throws `MethodNotImplemented('fs ftp does not support writing streams')` |
| `exists(path)` | Root, `cd` to parent, `stat(baseName)` | `true` only for a **file**. A directory or any error gives `false` |
| `dirExists(path)` | Root, `cd` to parent, `stat(baseName)` | `true` when the entry is a directory; any error gives `false`. See [Important behaviour](#important-behaviour) |
| `stat(path)` | `cd` to parent from the **current** directory, `LIST` base name, find the entry by name | `IStat` with `IsFile`, `IsDirectory`, `Size`, `ModifiedTime`, `AdditionalData` (the `basic-ftp` `FileInfo`). `AccessTime`, `CreationTime`, `Version` stay `undefined`. Not found: `null` |
| `isDir(path)` | `stat(path)` | `IsDirectory`. Throws `TypeError` when the entry does not exist |
| `list(path)` | `cd` to parent from the current directory, `LIST` base name | Entry names (files and directories). `list('/')` lists the root |
| `mkdir(path)` | `Client.ensureDir(path)` from the current directory | Creates every missing segment. Leaves the connection inside the new directory |
| `rename(oldPath, newPath)` | `RNFR` / `RNTO` from the current directory | Renames or moves within the server |
| `move(oldPath, newPath)` | `rename()` | Same server only |
| `move(oldPath, newPath, dstFs)` | `download()`, `dstFs.upload(temp, newPath)`, `DELE oldPath`, `TempFs.rm(temp)` | Moves to another provider |
| `copy(path, dest)` | `download()`, `STOR dest` from the current directory, `TempFs.rm(temp)` | No directories are created for `dest` |
| `copy(path, dest, dstFs)` | `download()`, `dstFs.upload(temp, dest)`, `TempFs.rm(temp)` | Copies to another provider |
| `rm(path)` | Root, `cd` to parent, `DELE` base name | Deletes **files only**; a directory fails with the server's `550` reply |
| `zip(paths, dstFs?, dstFile?)` | `download()` each entry, `TempFs.zip()` | `IZipResult` on `dstFs`, default `fs-temp`. Entry names are base names; a `[remotePath, entryName]` pair renames an entry. Directories are not supported |
| `unzip(path, destPath?, dstFs?)` | `download()`, `TempFs.unzip(temp, destPath, dstFs ?? TempFs)`, `TempFs.rm(temp)` | Path of the extracted content. `dstFs` must be a local provider; extracting onto FTP is not supported |
| `tmppath()` | none | Throws `MethodNotImplemented` |
| `resolvePath(path)` | none | An absolute path comes back unchanged; a relative one throws `MethodNotImplemented` |
| `hash(path, algo?)`, `metadata(path)` | inherited from `fs`: both call `resolvePath()` | Do not work on FTP paths; see [Patterns and antipatterns](#patterns-and-antipatterns) |
| `signedUrl` | not implemented | `ftp.signedUrl` is `undefined` |

The static `fs.*(uri)` methods and the `@spinajs/fs` helpers (`read()`, `copy()`, `zip()` ...) delegate to these instance methods, so the same rules apply to `fs://ftp/...` URIs.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Temp file storage | Provider named `fs-temp`, read through `@FileSystem('fs-temp')` on every call | Your `fs-temp` entry | `fsNative`, `fsTemp` over a local backend | Configure a different provider under `fs-temp`; it must hand out local absolute paths |
| Path navigation | `protected` methods `_restoreRootDir()`, `_setWorkingDir()`, `_ensureDir()` of `fsFTP` | `fsFTP` | | Override them in a subclass: [Extending the FTP provider](03-extending-the-ftp-provider.md) |
| Unsupported methods | `writeStream()`, `tmppath()`, `resolvePath()` of `fsFTP` | throw `MethodNotImplemented` | | Implement them in a subclass; [streaming uploads](03-extending-the-ftp-provider.md#add-streaming-uploads) shows `writeStream()` |

## Important behaviour

- **One command at a time.** `basic-ftp` rejects a command started while another runs: `User launched a task while another one is still running`. `fsFTP` does not queue calls, so two concurrent requests on the same provider fail. Serialize them, for example with the [queue decorator](04-decorating-the-ftp-provider.md#serialize-concurrent-calls).
- **`readStream()` holds the connection.** The download keeps running after the promise resolves. Consume the stream to the end before the next call on that provider.
- **Methods that do not reset the working directory.** `stat()`, `isDir()`, `list()`, `mkdir()`, `rename()`, same-server `move()`, the upload in same-server `copy()` and the delete in cross-provider `move()` resolve relative paths against the directory the previous call left. Pass these methods paths that start with `/`.
- **Cross-provider `move()` from a subdirectory.** After `download()` the connection sits in the source file's directory, and `move()` then sends `DELE <oldPath>` with the full relative path. For `outgoing/a.xml` the server looks for `outgoing/outgoing/a.xml`: the copy lands on `dstFs`, the delete fails. Files in the root are not affected.
- **Same-server `copy()`** uploads `dest` relative to the source file's directory and creates no directories, so `copy('in/a.xml', 'archive/a.xml')` targets `in/archive/a.xml`.
- **Directories in `dirExists()` and `isDir()`.** `stat()` sends `LIST <name>`; for a directory most servers return its content, not its own entry. `dirExists()` then returns `false` and `isDir()` throws, unless the directory holds an entry with its own name. <!-- TODO(docs-hook): verify dirExists()/isDir() against the test FTP server ( garethflowers/ftp-server ) for a directory -->
- **Temp files.** `download()` names the temp file with `tmppath()` and no extension. Consumers that pick behaviour from the extension (templates, file info) see none. `read()` leaves its temp file behind when `TempFs.read()` throws.
- **`ModifiedTime`** is built from `FileInfo.modifiedAt`. When the server's listing has no parseable date, it is an invalid Luxon `DateTime`, not `undefined`.
- **No error mapping.** A missing file fails with the raw `FTPError` (`550 ...`), not `IOFail`.

## Best practices

- Call operations on one provider one after another (`for ... of` with `await`), never with `Promise.all()`.
- Use `copy(path, dest, getFs('local'))` to pull a file off the server: it handles the temp file for you. Follow it with `rm(path)` instead of calling `move(path, dest, getFs('local'))` for files in subdirectories.
- Delete what `download()` returns with `getFs('fs-temp').rm(localPath)`, or use `fsTemp` with `cleanup: true` as `fs-temp`.
- Check existence with `exists()`, which resets the working directory and returns `false` instead of throwing.

## Patterns and antipatterns

```ts
// Don't: both writes share one FTP control connection; the second one throws
await Promise.all(invoices.map((i) => ftp.write(`out/${i.no}.xml`, i.xml)));

// Do
for (const i of invoices) {
  await ftp.write(`out/${i.no}.xml`, i.xml);
}
```

```ts
// Don't: hash() calls resolvePath(), which throws for an FTP path
const checksum = await ftp.hash('incoming/batch.zip');

// Do: hash the local temp copy, then delete it
const local = await ftp.download('incoming/batch.zip');
const checksum = await fileHash(local);
await getFs('fs-temp').rm(local);
```

```ts
// Don't: relative path, resolved against whatever directory the last call left
const names = await ftp.list('incoming');

// Do
const names = await ftp.list('/incoming');
```

## Examples

### Pull new orders from a partner's FTP drop folder

```ts sample
import { getFs } from '@spinajs/fs';
import '@spinajs/fs-ftp';

export async function importOrders(): Promise<string[]> {
  const ftp = getFs('ftp-partner');
  const local = getFs('local');
  const imported: string[] = [];

  for (const name of await ftp.list('/outgoing')) {
    if (!name.endsWith('.xml') || !(await ftp.exists(`outgoing/${name}`))) {
      continue;
    }

    // copy() + rm() instead of move(..., local): see "Important behaviour"
    await ftp.copy(`outgoing/${name}`, `orders/incoming/${name}`, local);
    await ftp.rm(`outgoing/${name}`);
    imported.push(name);
  }

  return imported;
}
```

### Verify a download against the checksum the partner publishes

```ts sample
import { fileHash, getFs } from '@spinajs/fs';
import '@spinajs/fs-ftp';

export async function verifyBatch(batch: string): Promise<boolean> {
  const ftp = getFs('ftp-partner');
  const expected = ((await ftp.read(`outgoing/${batch}.md5`, 'utf-8')) as string).trim();

  const local = await ftp.download(`outgoing/${batch}.zip`);

  try {
    return (await fileHash(local)) === expected;
  } finally {
    await getFs('fs-temp').rm(local);
  }
}
```

### Stream a large export to local disk

```ts sample
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getFs } from '@spinajs/fs';
import '@spinajs/fs-ftp';

export async function fetchExport(remotePath: string, localPath: string) {
  const ftp = getFs('ftp-partner');
  const source = await ftp.readStream(remotePath);

  // the provider stays busy until the pipeline ends; no other call on it before that
  await pipeline(source, createWriteStream(localPath));
}
```

### Ship a monthly bundle as one zip

```ts sample
import { getFs } from '@spinajs/fs';
import '@spinajs/fs-ftp';

export async function bundleMonth(month: string) {
  const ftp = getFs('ftp-archive');
  const local = getFs('local');

  const result = await ftp.zip(
    [
      [`reports/${month}/sales.csv`, `${month}-sales.csv`],
      [`reports/${month}/returns.csv`, `${month}-returns.csv`],
    ],
    local,
    `bundles/${month}.zip`,
  );

  return result.asFilePath();
}
```

## Related

- [FTP provider](01-ftp-provider.md): configuration, connection, `fs-temp`.
- [Extending the FTP provider](03-extending-the-ftp-provider.md): implement `writeStream()`, keep extensions on download.
- [`@spinajs/fs`](../fs/README.md): the abstract `fs` API, `IStat`, `IZipResult`, `fileHash()`.
