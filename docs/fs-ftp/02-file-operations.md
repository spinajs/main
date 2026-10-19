# File operations

What each `fs` method does on an `fsFTP` provider. The API is the abstract `fs` from `@spinajs/fs`; this page lists where FTP changes the outcome: the shared working directory, temp downloads, and the methods FTP cannot support.

## How it works

Every `fsFTP` instance owns one `basic-ftp` `Client` and one control connection. The connection has one current working directory, which methods change with `cd`.

1. A call such as `ftp.write('reports/2026/q3.csv', csv)` enters the `fsFTP` method.
2. Every method that talks to the server first calls `_restoreRootDir()`: it reads `pwd` and sends `cd ..` once per path segment until the connection is back at `/`.
3. They then call `_setWorkingDir(path)`, which sends `cd /<parent>` (or `cd .` for a file in the root), or `_ensureDir(path)`, which creates the parent directories with `Client.ensureDir()` first.
4. The FTP command runs against the file's base name: `uploadFrom`, `appendFrom`, `downloadTo`, `list`, `remove` or `removeDir`. `mkdir()` and `rename()` send their paths relative to the root instead.
5. Methods that need the bytes locally (`read()`, `copy()`, cross-provider `move()`, `hash()`, `metadata()`, `zip()`, `unzip()`) first `download()` the file into the `fs-temp` provider and delete the temp copy afterwards.
6. `basic-ftp` errors (`FTPError` with the server's reply code, socket errors) reach the caller unchanged; `fsFTP` does not map them.

## Method reference

| Method | Steps on the server | Result |
| --- | --- | --- |
| `download(path)` | Root, `cd` to parent, `RETR` into `fs-temp` via `TempFs.writeStream(TempFs.tmppath(extname(path)))` | Absolute local temp path with the remote file's extension. You delete it |
| `read(path, encoding)` | `download()`, `TempFs.read()`, `TempFs.rm()` | File content as `string` (with `encoding`) or `Buffer`. The temp copy is deleted also when the read fails |
| `readStream(path, encoding?)` | Root, `cd` to parent, starts `RETR` into a `PassThrough` without waiting | The `PassThrough`. A transfer error destroys it with that error |
| `write(path, data, encoding?)` | Root, `ensureDir` parent, `STOR` base name | Creates missing directories, overwrites an existing file |
| `append(path, data, encoding?)` | Root, `ensureDir` parent, `APPE` base name | Appends to the remote file; FTP servers create it when missing |
| `upload(localPath, destPath?, options?)` | Root, `ensureDir` parent, `STOR` from the local file | `destPath` defaults to the base name of `localPath`, in the root. With `{ exclusive: true }` an existing file throws `ResourceDuplicated`. The provider checks `exists()` inside the action frame (unchecked), after every middleware's `before`; the check is not atomic, so two clients can still race |
| `writeStream(...)` | none | Throws `MethodNotImplemented('fs ftp does not support writing streams')` |
| `exists(path)` | `stat(path)` | `true` only for a **file**. A directory or any error gives `false` |
| `dirExists(path)` | `stat(path)` | `true` when the entry is a directory; any error gives `false` |
| `stat(path)` | Root, `cd` to parent, `LIST` the parent, find the entry by base name | `IStat` with `IsFile`, `IsDirectory`, `Size`, `ModifiedTime`, `AdditionalData` (the `basic-ftp` `FileInfo`). `AccessTime`, `CreationTime`, `Version` stay `undefined`. Not found: `null` |
| `isDir(path)` | `stat(path)` | `IsDirectory`; `false` when the entry does not exist |
| `list(path)` | Root, `cd` to parent, `LIST` base name | Entry names (files and directories). `list('/')` lists the root |
| `mkdir(path)` | Root, `Client.ensureDir(path)` | Creates every missing segment. Leaves the connection inside the new directory |
| `rename(oldPath, newPath)` | Root, `RNFR` / `RNTO` | Renames or moves within the server |
| `move(oldPath, newPath)` | `rename()` | Same server only |
| `move(oldPath, newPath, dstFs)` | `download()`, `dstFs.upload(temp, newPath)`, `rm(oldPath)`, `TempFs.rm(temp)` | Moves to another provider |
| `copy(path, dest)` | `download()`, `upload(temp, dest)`, `TempFs.rm(temp)` | Creates missing directories of `dest` |
| `copy(path, dest, dstFs)` | `download()`, `dstFs.upload(temp, dest)`, `TempFs.rm(temp)` | Copies to another provider |
| `rm(path)` | `stat(path)`, then `DELE` base name, or `Client.removeDir()` for a directory | Deletes a file, or a directory with all its content. A missing file fails with the server's `550` reply |
| `zip(paths, dstFs?, dstFile?)` | `download()` each entry, `TempFs.zip()` | `IZipResult` on `dstFs`, default `fs-temp`. Entry names are the normalised remote paths; a `[remotePath, entryName]` pair renames an entry. Directories are not supported |
| `unzip(path, destPath?, dstFs?)` | `download()`, `TempFs.unzip(temp, destPath, dstFs ?? TempFs)`, `TempFs.rm(temp)` | Path of the extracted content. `dstFs` must be a local provider; extracting onto FTP is not supported |
| `tmppath()` | none | Throws `MethodNotImplemented` |
| `resolvePath(path)` | none | Throws `MethodNotImplemented` |
| `hash(path, algo?)`, `metadata(path)` | `download()`, `FileHasher.hash()` / `FileInfo.getInfo()` on the temp copy, `TempFs.rm(temp)` | Hash or `IFileInfo` of the remote file |
| `signedUrl(path, opts?)`, `getSignedUrl(path, until?)` | none | Throw `MethodNotImplemented`: `fsFTP` has no `doSignedUrl` |

The static `fs.*(uri)` methods and the `@spinajs/fs` helpers (`read()`, `copy()`, `zip()` ...) delegate to these instance methods, so the same rules apply to `fs://ftp/...` URIs.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Temp file storage | Provider named `fs-temp`, read through `@FileSystem('fs-temp')` on every call | Your `fs-temp` entry | `fsNative`, `fsTemp` over a local backend | Configure a different provider under `fs-temp`; it must hand out local absolute paths |
| Path navigation | `protected` methods `_restoreRootDir()`, `_setWorkingDir()`, `_ensureDir()` of `fsFTP` | `fsFTP` | | Override them in a subclass: [Extending the FTP provider](03-extending-the-ftp-provider.md) |
| Unsupported methods | `writeStream()`, `tmppath()`, `resolvePath()` of `fsFTP` | throw `MethodNotImplemented` | | Implement them in a subclass; [streaming uploads](03-extending-the-ftp-provider.md#add-streaming-uploads) shows `writeStream()` |

## Important behaviour

- **One command at a time.** `basic-ftp` rejects a command started while another runs: `User launched a task while another one is still running`. `fsFTP` does not queue calls, so two concurrent requests on the same provider fail. Serialize them in a subclass: [Serialize concurrent calls](03-extending-the-ftp-provider.md#serialize-concurrent-calls).
- **`readStream()` holds the connection.** The download keeps running after the promise resolves. Consume the stream to the end before the next call on that provider.
- **Paths are relative to the root.** Every method resets the working directory first, so a relative path means the same thing whatever the previous call did.
- **`stat()` lists the whole parent directory.** `LIST <name>` cannot be used, because for a directory servers return its content, not its own entry. In a directory with many entries every `stat()`, `exists()`, `dirExists()`, `isDir()` and `rm()` transfers the full listing.
- **`ModifiedTime`** is built from `FileInfo.modifiedAt`. When the server's listing has no parseable date, it is an invalid Luxon `DateTime`, not `undefined`.
- **Calls inside an action are unchecked.** `read()` calls `download()`, `exists()` calls `stat()`, `copy()` calls `dstFs.upload()` and `TempFs` calls run inside the action frame, so [middlewares](04-middlewares-on-the-ftp-provider.md) see only the outer call.
- **No error mapping.** A missing file fails with the raw `FTPError` (`550 ...`), not `IOFail`.

## Best practices

- Call operations on one provider one after another (`for ... of` with `await`), never with `Promise.all()`.
- Use `copy(path, dest, getFs('local'))` or `move(path, dest, getFs('local'))` to pull a file off the server: they handle the temp file for you.
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
// Don't: resolvePath() throws, there is no local path for an FTP file
const checksum = await fileHash(ftp.resolvePath('incoming/batch.zip'));

// Do: hash() downloads the file to fs-temp and deletes the copy afterwards
const checksum = await ftp.hash('incoming/batch.zip');
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

    await ftp.move(`outgoing/${name}`, `orders/incoming/${name}`, local);
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
- [Extending the FTP provider](03-extending-the-ftp-provider.md): implement `writeStream()`, reconnect after a dropped connection.
- [`@spinajs/fs`](../fs/README.md): the abstract `fs` API, `IStat`, `IZipResult`, `fileHash()`.
