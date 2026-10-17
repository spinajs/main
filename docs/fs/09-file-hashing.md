# File hashing

`FileHasher` computes a digest of a file, an in-memory buffer or a stream. Providers use it in `hash()`; you can resolve it directly for deduplication, integrity checks or cache keys.

## How it works

1. `provider.hash(path, algo?)` resolves `DI.resolve(FileHasher, [algo])` and calls `hasher.hash(provider.resolvePath(path))`.
2. `fileHash(path)` resolves `FileHasher` with no arguments and hashes an absolute local path.
3. The default `DefaultFileHasher` takes the algorithm from its first constructor argument, else `fs.hasher.defaultAlgorithm`, else `sha256`.
4. `PerInstanceCheck` keeps one instance per algorithm: `__checkInstance__` compares the requested algorithm (or the configured default) with the instance's `Algorithm`.
5. Each call checks the algorithm against `crypto.getHashes()` and throws `IOFail` (`Unsupported hash algorithm`) when it is not there.
6. `hash()` throws `IOFail` when the file does not exist, then streams the file through the hash. Read errors become `IOFail`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.hasher.defaultAlgorithm` | `string` | `sha256` | any name in `crypto.getHashes()` | Algorithm when a caller passes none. |

```ts
{ fs: { hasher: { defaultAlgorithm: 'sha512' } } }
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FileHasher` | `FileHasher`, `PerInstanceCheck` in the default; resolved with `[algo]` as constructor arguments | `DefaultFileHasher` | none | Replace: `DI.register(MyHasher).as(FileHasher)` (last registration wins). Extend: subclass `DefaultFileHasher` and override `createHasher()` or `digestStream()`. |

### `FileHasher` API

| Method | Returns | Meaning |
| --- | --- | --- |
| `hash(pathToFile, encoding = 'hex')` | `Promise<string>` | Digest of a local file. |
| `hashData(data, encoding = 'hex')` | `Promise<string>` | Digest of a string or `Uint8Array`. |
| `hashStream(stream, encoding = 'hex')` | `Promise<string>` | Digest of a stream, consumed to the end. |

`encoding` is a node `BinaryToTextEncoding`: `hex`, `base64`, `base64url` or `latin1`.

`DefaultFileHasher` also takes `HashOptions` (node `crypto.HashOptions`, eg. `outputLength` for `shake256`) as its second constructor argument.

### `FileHasher`: custom implementation

Replace the hasher when digests must not be guessable from the content alone. This one computes a keyed HMAC, so a stored digest cannot be checked against a known file without the secret.

```ts sample
import { createHmac, BinaryToTextEncoding, Hmac } from 'crypto';
import { createReadStream } from 'fs';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { IOFail } from '@spinajs/exceptions';
import { FileHasher, getFs } from '@spinajs/fs';

// config: { app: { fileHashSecret: '<random secret>' } }
@Injectable(FileHasher)
@PerInstanceCheck()
export class HmacFileHasher extends FileHasher {
  @Config('app.fileHashSecret')
  protected Secret: string;

  constructor(public Algorithm: string = 'sha256') {
    super();
  }

  public __checkInstance__(creationOptions: unknown[]): boolean {
    return this.Algorithm === ((creationOptions?.[0] as string | undefined) ?? 'sha256');
  }

  protected hmac(): Hmac {
    if (!this.Secret) {
      throw new IOFail('app.fileHashSecret is not configured');
    }
    return createHmac(this.Algorithm, this.Secret);
  }

  public async hash(pathToFile: string, encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
    return this.hashStream(createReadStream(pathToFile), encoding);
  }

  public async hashData(data: string | Uint8Array, encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
    return this.hmac().update(data).digest(encoding);
  }

  public hashStream(stream: NodeJS.ReadableStream, encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
    const hmac = this.hmac();
    return new Promise((resolve, reject) => {
      stream
        .on('data', (chunk) => hmac.update(chunk))
        .on('end', () => resolve(hmac.digest(encoding)))
        .on('error', (err) => reject(new IOFail('Cannot hash stream', err)));
    });
  }
}

export async function fingerprintUpload(path: string): Promise<string> {
  return getFs('uploads').hash(path);
}

export function useHmacHashing(): void {
  DI.register(HmacFileHasher).as(FileHasher);
}
```

Importing the module runs `@Injectable(FileHasher)` after `DefaultFileHasher` registered, so `HmacFileHasher` is the last registration and wins. `DI.register(HmacFileHasher).as(FileHasher)` does the same without the decorator. Register it at startup, before code hashes files.

### Extending `DefaultFileHasher`: forbid weak algorithms

Subclass the default when node `crypto` is right and one rule changes. `createHasher()` runs on every call, so a check there covers `hash()`, `hashData()` and `hashStream()`.

```ts sample
import crypto from 'crypto';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { DefaultFileHasher, FileHasher } from '@spinajs/fs';

const WEAK_ALGORITHMS = ['md5', 'sha1', 'md4'];

@Injectable(FileHasher)
@PerInstanceCheck()
export class StrongFileHasher extends DefaultFileHasher {
  protected createHasher(): crypto.Hash {
    if (WEAK_ALGORITHMS.includes((this.Algorithm ?? '').toLowerCase())) {
      throw new IOFail(`Hash algorithm '${this.Algorithm}' is not allowed, use sha256 or stronger`);
    }
    return super.createHasher();
  }
}
```

## Important behaviour

- The JSDoc of `fs.hash()` names `md5` as default; the real default is `fs.hasher.defaultAlgorithm`, then `sha256`.
- The default instance cache keys on the algorithm only. Two resolves with the same algorithm and different `HashOptions` return the first instance.
- A replacement without `PerInstanceCheck` is a singleton: the algorithm of the first `fs.hash(path, algo)` call then applies to every later call.
- The inherited `hash()` of a provider hashes `resolvePath(path)`, a local path. Providers without local paths override `hash()` (see [Custom providers](06-custom-providers.md)).
- `fsTemp.hash()` forwards to its backend's `hash()`.

## Best practices

- Set `fs.hasher.defaultAlgorithm` once instead of passing `algo` at each call; mixed algorithms make stored digests incomparable.
- Use `hashStream()` for upload bodies; it does not buffer the content.
- Store the algorithm next to each stored digest when you may change the default later.

## Patterns and antipatterns

```ts
// Don't: reads the whole file into memory first
const digest = await hasher.hashData((await uploads.read('video.mp4')) as Buffer);

// Do: stream it
const digest = await uploads.hash('video.mp4');
```

## Examples

### Skip duplicate uploads

```ts sample
import { DI } from '@spinajs/di';
import { FileHasher, getFs } from '@spinajs/fs';
import { Readable } from 'stream';

const knownDigests = new Set<string>();

export async function storeIfNew(fileName: string, content: Buffer): Promise<boolean> {
  const hasher = DI.resolve<FileHasher>(FileHasher, ['sha256']);
  const digest = await hasher.hashStream(Readable.from([content]));

  if (knownDigests.has(digest)) {
    return false;
  }

  await getFs('uploads').write(`${digest}-${fileName}`, content);
  knownDigests.add(digest);
  return true;
}
```

## Related

- [File operations](02-file-operations.md): `hash()` on every provider.
- [CLI commands](11-cli-commands.md): `fs-hash` from the terminal.
