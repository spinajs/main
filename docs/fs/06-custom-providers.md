# Custom providers

A provider is a subclass of the abstract `fs` class. Write one to put a new storage backend behind the same API: a cloud bucket, a database blob table, an in-memory store for tests. Code that uses `getFs('name')` does not change.

## How it works

1. You subclass `fs` and decorate it with `@Injectable('fs')` and `@PerInstanceCheck()`. Importing the module registers it.
2. You add a provider entry whose `service` is the class name.
3. `fsService` resolves the class with the entry as the only constructor argument, and awaits `resolve()` (the class is an `AsyncService`).
4. `fs.__checkInstance__()` compares `Name` with the entry's `name`, so each entry gets one instance.
5. `fsService` publishes the instance under `name`. Callers get the instance itself; the base class runs the registered [middlewares](07-middlewares.md) around every public method.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| File provider | `'fs'` (equal to the `fs` class token), `PerInstanceCheck` per `name` | `fsNative` | `fsTemp`; `fsS3` (`@spinajs/fs-s3`), `fsFTP` (`@spinajs/fs-ftp`), `fsOneDrive` (`@spinajs/fs-onedrive`) | Subclass `fs` (new backend) or `fsNative` (local disk with changes, see [Local provider](03-local-provider.md#extending-fsnative)). Select it with `service`. |

### Contract

The public methods of `fs` ([File operations](02-file-operations.md#instance-api)) are final: they normalise the paths, run the [middlewares](07-middlewares.md) and call a protected `doX` hook with the normalised paths. A subclass implements the hooks (`doDownload`, `doUpload`, `doRead`, `doReadStream`, `doWrite`, `doWriteStream`, `doAppend`, `doExists`, `doDirExists`, `doStat`, `doIsDir`, `doList`, `doMkdir`, `doRm`, `doCopy`, `doMove`, `doRename`, `doZip`, `doUnzip`) plus `Name`, `resolvePath()` and `tmppath()`. A subclass that overrides a public method makes the base constructor throw `InvalidOperation`. Other parts of the package rely on these points:

| Member | Expected by |
| --- | --- |
| `Name` returns `Options.name` | `__checkInstance__`, `ServiceName`, log messages, `IZipResult.fs.Name` |
| constructor takes the provider entry | `fsService`, which passes it as the only argument |
| `doList(path)` returns entry names, `doStat(name)` works on them | [Cleanup strategies](05-temp-cleanup-strategies.md) when your provider is a temp backend |
| `doStat()` fills `CreationTime` or `ModifiedTime` | Age-based cleanup; entries without either are never deleted |
| `doUpload(localPath, dest, options?)` accepts a local path and honours `options.exclusive` | `copy()` and `move()` into your provider reach it through `dstFs.upload` |
| `doWriteStream(path)` | `zip()` into your provider |
| `resolvePath(path)` returns a local path | the default `doHash()` and `doMetadata()`; override both when you have no local paths |
| `tmppath(ext)` returns a writable local path | `fsTemp.tmppath()` when you are its backend; remote providers download into it |

`doSignedUrl()` is optional; without it `signedUrl()` throws `MethodNotImplemented`. `doHash()`, `doMetadata()`, `doHasEntries()` and `tmpname()` have default implementations.

### Custom provider: in-memory files for tests

```ts sample
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { IOFail, MethodNotImplemented, ResourceDuplicated } from '@spinajs/exceptions';
import { FileHasher, FileInfoService, fs, fsService, getFs, IFileInfo, IFsUploadOptions, IStat, IZipResult } from '@spinajs/fs';
import { DateTime } from 'luxon';
import { PassThrough, Readable } from 'stream';
import { WriteStream } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

interface IMemoryFsOptions {
  name: string;
}

interface IMemoryEntry {
  data: Buffer;
  created: DateTime;
  modified: DateTime;
}

// config: { service: 'MemoryFs', name: 'test-files' }
@Injectable('fs')
@PerInstanceCheck()
export class MemoryFs extends fs {
  protected Files = new Map<string, IMemoryEntry>();

  constructor(public Options: IMemoryFsOptions) {
    super();
  }

  public get Name(): string {
    return this.Options.name;
  }

  protected entry(path: string): IMemoryEntry {
    const found = this.Files.get(path);
    if (!found) {
      throw new IOFail(`File ${path} not exists in ${this.Name}`);
    }
    return found;
  }

  protected store(path: string, data: Buffer): void {
    const existing = this.Files.get(path);
    const now = DateTime.now();
    this.Files.set(path, { data, created: existing?.created ?? now, modified: now });
  }

  protected async doDownload(path: string): Promise<string> {
    const local = this.tmppath();
    await writeFile(local, this.entry(path).data);
    return local;
  }

  protected async doUpload(srcPath: string, destPath: string, options?: IFsUploadOptions): Promise<void> {
    if (options?.exclusive && this.Files.has(destPath)) {
      throw new ResourceDuplicated(`File ${destPath} already exists in ${this.Name}`);
    }
    this.store(destPath, await readFile(srcPath));
  }

  protected async doHash(path: string, algo?: string): Promise<string> {
    return DI.resolve<FileHasher>(FileHasher, [algo]).hashData(this.entry(path).data);
  }

  protected async doMetadata(path: string): Promise<IFileInfo> {
    return DI.resolve<FileInfoService>(FileInfoService).getInfo(await this.doDownload(path));
  }

  public resolvePath(path: string): string {
    throw new MethodNotImplemented(`MemoryFs ${this.Name} has no local paths, use download() for ${path}`);
  }

  protected async doRead(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const data = this.entry(path).data;
    return encoding ? data.toString(encoding) : Buffer.from(data);
  }

  protected async doReadStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    const stream = Readable.from([this.entry(path).data]);
    if (encoding) {
      stream.setEncoding(encoding);
    }
    return stream;
  }

  protected async doWrite(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    this.store(path, typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data));
  }

  protected async doWriteStream(path: string, rStream?: BufferEncoding | NodeJS.ReadableStream, encoding?: BufferEncoding): Promise<WriteStream | PassThrough> {
    const target = new PassThrough();
    const chunks: Buffer[] = [];

    target.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    target.on('finish', () => this.store(path, Buffer.concat(chunks)));

    if (rStream && typeof rStream !== 'string') {
      rStream.on('error', (err) => target.destroy(err));
      rStream.pipe(target);
    }

    return target;
  }

  protected async doAppend(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const current = this.Files.get(path)?.data ?? Buffer.alloc(0);
    const added = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
    this.store(path, Buffer.concat([current, added]));
  }

  protected async doExists(path: string): Promise<boolean> {
    return this.Files.has(path);
  }

  protected async doDirExists(path: string): Promise<boolean> {
    return this.doIsDir(path);
  }

  protected async doIsDir(path: string): Promise<boolean> {
    return path === '' || [...this.Files.keys()].some((k) => k.startsWith(`${path}/`));
  }

  protected async doCopy(path: string, dest: string, dstFs?: fs): Promise<void> {
    const data = this.entry(path).data;
    if (dstFs) {
      await dstFs.write(dest, data);
    } else {
      this.store(dest, Buffer.from(data));
    }
  }

  protected async doMove(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    await this.doCopy(oldPath, newPath, dstFs);
    await this.doRm(oldPath);
  }

  protected async doRename(oldPath: string, newPath: string): Promise<void> {
    await this.doMove(oldPath, newPath);
  }

  protected async doRm(path: string): Promise<void> {
    for (const k of [...this.Files.keys()]) {
      if (k === path || k.startsWith(`${path}/`)) {
        this.Files.delete(k);
      }
    }
  }

  protected async doMkdir(path: string): Promise<void> {
    // directories exist implicitly through the keys of their files
  }

  protected async doStat(path: string): Promise<IStat> {
    const file = this.Files.get(path);
    if (file) {
      return { IsFile: true, IsDirectory: false, Size: file.data.length, CreationTime: file.created, ModifiedTime: file.modified };
    }
    if (await this.doIsDir(path)) {
      return { IsFile: false, IsDirectory: true };
    }
    throw new IOFail(`Cannot stat ${path} in ${this.Name}`);
  }

  protected async doList(path: string): Promise<string[]> {
    const names = new Set<string>();
    for (const k of this.Files.keys()) {
      const rest = path === '' ? k : k.startsWith(`${path}/`) ? k.slice(path.length + 1) : null;
      if (rest) {
        names.add(rest.split('/')[0]);
      }
    }
    return [...names];
  }

  public tmppath(ext?: string): string {
    return join(tmpdir(), this.tmpname(ext));
  }

  protected async doZip(path: string | (string | string[])[], dstFs: fs, dstFile: string): Promise<IZipResult> {
    throw new MethodNotImplemented(`MemoryFs ${this.Name} does not zip`);
  }

  protected async doUnzip(srcPath: string, destPath: string, dstFs: fs): Promise<string> {
    throw new MethodNotImplemented(`MemoryFs ${this.Name} does not unzip`);
  }
}

export async function seedTestFiles(): Promise<string[]> {
  await DI.resolve(fsService);

  const files = getFs('test-files');
  await files.write('fixtures/users.json', JSON.stringify([{ Id: 1, Login: 'admin' }]), 'utf-8');
  await files.append('fixtures/log.txt', 'seeded\n', 'utf-8');

  return files.list('fixtures');
}
```

## Important behaviour

- The class name is the `service` value. Two provider classes with the same name collide in the registry.
- `fsService` passes only the provider entry to the constructor. Resolve other services with `@Autoinject()`, `@Config()` or `@FileSystem()` properties, as `fsS3` and `fsFTP` do.
- A provider that needs another provider in `resolve()` must name it in its entry's `provider` key; only then does `fsService` create it first.
- `getFs(name)` inside `resolve()` returns the other provider itself.
- Throw `IOFail` for storage failures, to match `fsNative`. Throw `MethodNotImplemented` for operations the backend cannot do.

## Best practices

- Subclass `fsNative` instead of `fs` when files live on local disk: you keep the sandbox, zip and stream handling.
- Override `doHash()` and `doMetadata()` when `resolvePath()` cannot return a local path.
- Make `doUpload()` accept directories if callers will `copy()` directories into your provider from `fsNative`.
- Honour `options.exclusive` in `doUpload()`: throw `ResourceDuplicated` when `dest` exists, atomically if the backend can create-if-absent. Callers such as `@spinajs/configuration-http` rely on it to not overwrite a file.

## Patterns and antipatterns

```ts
// Don't: Name as a constant breaks one-instance-per-name and every second entry of this service
public Name = 'memory';

// Do: take it from the provider entry
public get Name(): string {
  return this.Options.name;
}
```

## Migration

Public overrides become protected `doX` hooks, and `FsDecorator` becomes `FsMiddleware`. `fsService.decorate()` is removed, and `getFs()` returns the provider itself.

```ts
// Before: the provider overrode the public method, and a decorator wrapped the provider
class MyFs extends fs {
  public async read(path: string, encoding?: BufferEncoding) { /* ... */ }
}
fsService.decorate(AuditDecorator);

// After: the provider implements the protected hook, and a middleware replaces the decorator
class MyFs extends fs {
  protected async doRead(path: string, encoding?: BufferEncoding) { /* ... */ }
}

@Injectable(FsMiddleware)
class AuditMiddleware extends FsMiddleware {
  public async before(ctx: FsActionContext) { /* ... */ }
}
```

A subclass that still overrides a public action makes the base constructor throw `InvalidOperation`. See [Middlewares](07-middlewares.md).

## Related

- [File operations](02-file-operations.md): the API every provider implements.
- [Local provider](03-local-provider.md): a full implementation to read.
- [Middlewares](07-middlewares.md): observing every action instead of writing a provider.
