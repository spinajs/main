# Custom providers

A provider is a subclass of the abstract `fs` class. Write one to put a new storage backend behind the same API: a cloud bucket, a database blob table, an in-memory store for tests. Code that uses `getFs('name')` does not change.

## How it works

1. You subclass `fs` and decorate it with `@Injectable('fs')` and `@PerInstanceCheck()`. Importing the module registers it.
2. You add a provider entry whose `service` is the class name.
3. `fsService` resolves the class with the entry as the only constructor argument, and awaits `resolve()` (the class is an `AsyncService`).
4. `fs.__checkInstance__()` compares `Name` with the entry's `name`, so each entry gets one instance.
5. `fsService` publishes the instance under `name`, then runs [provider decorators](07-provider-decorators.md) over it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| File provider | `'fs'` (equal to the `fs` class token), `PerInstanceCheck` per `name` | `fsNative` | `fsTemp`; `fsS3` (`@spinajs/fs-s3`), `fsFTP` (`@spinajs/fs-ftp`), `fsOneDrive` (`@spinajs/fs-onedrive`) | Subclass `fs` (new backend) or `fsNative` (local disk with changes, see [Local provider](03-local-provider.md#extending-fsnative)). Select it with `service`. |

### Contract

Implement every abstract member listed in [File operations](02-file-operations.md#instance-api). Other parts of the package rely on these points:

| Member | Expected by |
| --- | --- |
| `Name` returns `Options.name` | `__checkInstance__`, `ServiceName`, log messages, `IZipResult.fs.Name` |
| constructor takes the provider entry | `fsService`, which passes it as the only argument |
| `list(path)` returns entry names, `stat(name)` works on them | [Cleanup strategies](05-temp-cleanup-strategies.md) when your provider is a temp backend |
| `stat()` fills `CreationTime` or `ModifiedTime` | Age-based cleanup; entries without either are never deleted |
| `upload(localPath, dest)` accepts a local path | `fsNative.copy()` and `move()` into your provider |
| `writeStream(path)` | `fsNative.zip()` writing an archive into your provider |
| `resolvePath(path)` returns a local path | the inherited `hash()` and `metadata()`; override both when you have no local paths |
| `tmppath(ext)` returns a writable local path | `fsTemp.tmppath()` when you are its backend; remote providers download into it |

`signedUrl?()` is optional. `hash()`, `metadata()` and `tmpname()` have default implementations.

### Custom provider: in-memory files for tests

```ts sample
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { IOFail, MethodNotImplemented } from '@spinajs/exceptions';
import { FileHasher, FileInfoService, fs, fsService, getFs, IFileInfo, IStat, IZipResult } from '@spinajs/fs';
import { DateTime } from 'luxon';
import { PassThrough, Readable } from 'stream';
import { WriteStream } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';

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

  protected key(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  protected entry(path: string): IMemoryEntry {
    const found = this.Files.get(this.key(path));
    if (!found) {
      throw new IOFail(`File ${path} not exists in ${this.Name}`);
    }
    return found;
  }

  protected store(path: string, data: Buffer): void {
    const existing = this.Files.get(this.key(path));
    const now = DateTime.now();
    this.Files.set(this.key(path), { data, created: existing?.created ?? now, modified: now });
  }

  public async download(path: string): Promise<string> {
    const local = this.tmppath();
    await writeFile(local, this.entry(path).data);
    return local;
  }

  public async upload(srcPath: string, destPath?: string): Promise<void> {
    this.store(destPath ?? basename(srcPath), await readFile(srcPath));
  }

  public async hash(path: string, algo?: string): Promise<string> {
    return DI.resolve<FileHasher>(FileHasher, [algo]).hashData(this.entry(path).data);
  }

  public async metadata(path: string): Promise<IFileInfo> {
    return DI.resolve<FileInfoService>(FileInfoService).getInfo(await this.download(path));
  }

  public resolvePath(path: string): string {
    throw new MethodNotImplemented(`MemoryFs ${this.Name} has no local paths, use download() for ${path}`);
  }

  public async read(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const data = this.entry(path).data;
    return encoding ? data.toString(encoding) : Buffer.from(data);
  }

  public async readStream(path: string, encoding?: BufferEncoding): Promise<NodeJS.ReadableStream> {
    const stream = Readable.from([this.entry(path).data]);
    if (encoding) {
      stream.setEncoding(encoding);
    }
    return stream;
  }

  public async write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    this.store(path, typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data));
  }

  public async writeStream(path: string, rStream?: BufferEncoding | NodeJS.ReadableStream, encoding?: BufferEncoding): Promise<WriteStream | PassThrough> {
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

  public async append(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const current = this.Files.get(this.key(path))?.data ?? Buffer.alloc(0);
    const added = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
    this.store(path, Buffer.concat([current, added]));
  }

  public async exists(path: string): Promise<boolean> {
    return this.Files.has(this.key(path)) || (await this.isDir(path));
  }

  public async dirExists(path: string): Promise<boolean> {
    return this.isDir(path);
  }

  public async isDir(path: string): Promise<boolean> {
    const prefix = this.key(path);
    return prefix === '' || [...this.Files.keys()].some((k) => k.startsWith(`${prefix}/`));
  }

  public async copy(path: string, dest: string, dstFs?: fs): Promise<void> {
    const data = this.entry(path).data;
    if (dstFs) {
      await dstFs.write(dest, data);
    } else {
      this.store(dest, Buffer.from(data));
    }
  }

  public async move(oldPath: string, newPath: string, dstFs?: fs): Promise<void> {
    await this.copy(oldPath, newPath, dstFs);
    await this.rm(oldPath);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    await this.move(oldPath, newPath);
  }

  public async rm(path: string): Promise<void> {
    const prefix = this.key(path);
    for (const k of [...this.Files.keys()]) {
      if (k === prefix || k.startsWith(`${prefix}/`)) {
        this.Files.delete(k);
      }
    }
  }

  public async mkdir(path: string): Promise<void> {
    // directories exist implicitly through the keys of their files
  }

  public async stat(path: string): Promise<IStat> {
    const file = this.Files.get(this.key(path));
    if (file) {
      return { IsFile: true, IsDirectory: false, Size: file.data.length, CreationTime: file.created, ModifiedTime: file.modified };
    }
    if (await this.isDir(path)) {
      return { IsFile: false, IsDirectory: true };
    }
    throw new IOFail(`Cannot stat ${path} in ${this.Name}`);
  }

  public async list(path: string): Promise<string[]> {
    const prefix = this.key(path);
    const names = new Set<string>();
    for (const k of this.Files.keys()) {
      const rest = prefix === '' ? k : k.startsWith(`${prefix}/`) ? k.slice(prefix.length + 1) : null;
      if (rest) {
        names.add(rest.split('/')[0]);
      }
    }
    return [...names];
  }

  public tmppath(ext?: string): string {
    return join(tmpdir(), this.tmpname(ext));
  }

  public async zip(path: string | (string | string[])[], dstFs?: fs, dstFile?: string): Promise<IZipResult> {
    throw new MethodNotImplemented(`MemoryFs ${this.Name} does not zip`);
  }

  public async unzip(srcPath: string, destPath?: string, dstFs?: fs): Promise<string> {
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
- `getFs(name)` inside `resolve()` returns the other provider **undecorated**; decorators run after every `resolve()`.
- Throw `IOFail` for storage failures, to match `fsNative`. Throw `MethodNotImplemented` for operations the backend cannot do.

## Best practices

- Subclass `fsNative` instead of `fs` when files live on local disk: you keep the sandbox, zip and stream handling.
- Override `hash()` and `metadata()` when `resolvePath()` cannot return a local path.
- Make `upload()` accept directories if callers will `copy()` directories into your provider from `fsNative`.

## Patterns and antipatterns

```ts
// Don't: Name as a constant breaks one-instance-per-name and every second entry of this service
public Name = 'memory';

// Do: take it from the provider entry
public get Name(): string {
  return this.Options.name;
}
```

## Related

- [File operations](02-file-operations.md): the API every provider implements.
- [Local provider](03-local-provider.md): a full implementation to read.
- [Provider decorators](07-provider-decorators.md): wrapping a provider instead of writing a new one.
