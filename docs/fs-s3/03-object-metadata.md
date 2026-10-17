# Object metadata

`fsS3` stores content hashes, and on `upload()` also file info, as S3 user metadata (`x-amz-meta-*`) on the object. `hash()`, `getMetadata()` and `metadata()` read it back with one `HeadObject`, without downloading the file.

## How it works

`upload(srcPath, destPath?)`:

1. Throws `IOFail` when `srcPath` does not exist on local disk.
2. Computes MD5 and SHA-256 of the local file through the base `fs.hash()`, which resolves `FileHasher` from DI.
3. Calls `FileInfoService.getInfo(srcPath)` and drops `Raw`. A failure is logged as a warning and the upload continues with hashes only.
4. Uploads with `Upload` from `@aws-sdk/lib-storage`. `Metadata` holds the subset below, each value converted with `String()`, `undefined` and `null` skipped.

| Stored key | Source |
| --- | --- |
| `FileSize`, `MimeType`, `Encoding` | `IFileInfo` |
| `Width`, `Height`, `Duration`, `FrameCount`, `FrameRate`, `AudioChannels`, `Bitrate`, `Codec` | `IFileInfo` (media) |
| `WordCount`, `LineCount` | `IFileInfo` (text) |
| `AccessDate`, `CreationDate`, `ModificationDate` | `IFileInfo`, as ISO strings |
| `hash` | SHA-256 of the content, hex |
| `md5` | MD5 of the content, hex |

The subset exists because S3 limits user metadata to 2 KB, and `IFileInfo` carries every raw exiftool tag.

`write(path, data, encoding?)` stores only `hash` and `md5`, computed from `data` in memory. `writeStream()` stores no metadata.

Reading it back:

| Method | Returns |
| --- | --- |
| `getMetadata(path)` | `Record<string, string> \| undefined`: the user metadata as S3 returns it, with **lowercased** keys (`height`, `mimetype`, `hash`). |
| `metadata(path)` | the same object, typed as `IFileInfo`. |
| `hash(path)` | the `hash` entry: the SHA-256 hex digest. Throws `InvalidArgument` when an algorithm is passed, and `IOFail` when the object has no `hash` entry. |
| `setMetadata(path, metadata)` | replaces all user metadata; see below. |

`setMetadata(path, metadata)`:

1. `HeadObjectCommand` reads the content headers.
2. `CopyObjectCommand` copies the object onto itself with `MetadataDirective: 'REPLACE'`, the new `Metadata`, and `ContentType`, `ContentEncoding`, `ContentDisposition`, `ContentLanguage`, `CacheControl` and `Expires` carried over. The key in `CopySource` is URL-encoded per segment.
3. A missing object rejects in step 1 with the SDK error.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FileInfoService` (from `@spinajs/fs`) | `FileInfoService`, singleton; injected into `fsS3.FileInfo` with `@Autoinject()` when the provider is created | `DefaultFileInfo` (exiftool based) | your own | `DI.register(MyInfo).as(FileInfoService)` before `fsService` resolves. Its result decides which keys `upload()` stores. |
| `FileHasher` (from `@spinajs/fs`) | `FileHasher`, `PerInstanceCheck`: one instance per algorithm, resolved as `DI.resolve(FileHasher, [algo])` | `DefaultFileHasher` (node `crypto`) | your own | `DI.register(MyHasher).as(FileHasher)`. Used only for the local file in `upload()`; `write()` hashes with `crypto` directly, and `hash()` on S3 reads metadata. |

### FileInfoService: custom implementation

Replace it when exiftool is not installed on the server, or when extracting media tags on every upload is too slow. `upload()` calls only `getInfo()`; `getInfoFromStream()` is part of the contract for other callers. Register it before `fsService` resolves, because `fsS3` receives its `FileInfo` when the provider is created.

```ts sample
import { DI } from '@spinajs/di';
import { FileInfoService, IFileInfo } from '@spinajs/fs';
import '@spinajs/fs-s3';
import { stat } from 'fs/promises';
import { extname } from 'path';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.csv': 'text/csv',
};

export class ExtensionFileInfo extends FileInfoService {
  public async getInfo(pathToFile: string): Promise<IFileInfo> {
    const s = await stat(pathToFile);
    return {
      FileSize: s.size,
      MimeType: MIME_BY_EXTENSION[extname(pathToFile).toLowerCase()] ?? 'application/octet-stream',
    };
  }

  public async getInfoFromStream(stream: NodeJS.ReadableStream): Promise<IFileInfo> {
    let size = 0;
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
    }
    return { FileSize: size };
  }
}

// before DI.resolve(fsService)
DI.register(ExtensionFileInfo).as(FileInfoService);
```

## Important behaviour

- **Keys come back lowercased, values as strings.** S3 normalizes metadata names, so `upload()` stores `Height` and `getMetadata()` returns `height: '1080'`. `metadata()` casts that object to `IFileInfo`, so `info.Height` is `undefined` at runtime; read lowercase keys from `getMetadata()`.
- **`hash()` is SHA-256, not MD5.** The `md5` entry exists, but `hash()` returns the `hash` entry, and passing an algorithm throws.
- **Only objects written through `write()`, `upload()` or `append()` have a hash.** Objects from `writeStream()` or from outside the application make `hash()` throw `IOFail`.
- **`setMetadata()` replaces everything.** Keys you leave out, `hash` and `md5` included, are deleted.
- **`setMetadata()` works up to 5 GB.** It copies the object onto itself, and a single `CopyObject` is limited to 5 GB.
- **`append()` refreshes the metadata**, because it re-uploads through `upload()`.
- **Metadata over 2 KB is rejected by S3.** Keep custom `setMetadata()` values short.

## Best practices

- Read file facts with `getMetadata()` and lowercase keys instead of downloading the object.
- Merge before you write: read `getMetadata()`, add your keys, keep `hash` and `md5`, then call `setMetadata()`.
- Use `hash()` to detect a changed object; use `stat().Version` (the ETag) only for equality checks.

## Patterns and antipatterns

```ts
// Don't: drops hash and md5, so hash() throws afterwards
await files.setMetadata(key, { 'reviewed-by': 'qa' });

// Do: keep the existing entries
const current = (await files.getMetadata(key)) ?? {};
await files.setMetadata(key, { ...current, 'reviewed-by': 'qa' });
```

## Examples

### Tag a document as approved

```ts sample
import { getFs } from '@spinajs/fs';
import { fsS3 } from '@spinajs/fs-s3';

export async function approveDocument(key: string, approver: string) {
  const documents = getFs('documents') as fsS3;

  const current = (await documents.getMetadata(key)) ?? {};
  await documents.setMetadata(key, {
    ...current,
    'approved-by': approver,
    'approved-at': new Date().toISOString(),
  });
}
```

### Reject an image that is too small, without downloading it

```ts sample
import { getFs } from '@spinajs/fs';
import { fsS3 } from '@spinajs/fs-s3';

export async function assertBannerSize(key: string) {
  const media = getFs('media') as fsS3;
  const meta = (await media.getMetadata(key)) ?? {};

  const width = Number(meta['width'] ?? 0);
  const height = Number(meta['height'] ?? 0);

  if (width < 1200 || height < 400) {
    throw new Error(`Banner ${key} is ${width}x${height}, expected at least 1200x400`);
  }
}
```

### Skip uploading an unchanged file

```ts sample
import { getFs, FileHasher } from '@spinajs/fs';
import { DI } from '@spinajs/di';
import '@spinajs/fs-s3';

export async function syncFile(localPath: string, key: string) {
  const backups = getFs('backups');

  if (await backups.exists(key)) {
    const remote = await backups.hash(key);
    const local = await DI.resolve<FileHasher>(FileHasher, ['sha256']).hash(localPath);
    if (remote === local) {
      return false;
    }
  }

  await backups.upload(localPath, key);
  return true;
}
```

## Related

- [S3 file provider](01-s3-file-provider.md): `upload`, `write` and the other operations.
- [Temporary files](02-temporary-files.md): `append()` re-uploads through `upload()`.
- [`@spinajs/fs`](../fs/README.md): `FileInfoService`, `IFileInfo` and `FileHasher`.
