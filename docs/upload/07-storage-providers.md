# Storage providers

The upload writes through two `@spinajs/fs` providers: a temp provider for the parts and a files provider for the merged files. They can be any providers, the same one or two, local or remote: local disk for the parts and S3 for the files is a common pair.

## How it works

1. The app defines both providers in `fs.providers`. The package ships none.
2. `upload.fs.temp` and `upload.fs.files` name them. A controller's `fsFor()` can name others per session; the names are stored on the session at create.
3. `UploadStorage` resolves the provider by name for every call. It uses only `writeStream` (always with `exclusive: true`), `readStream` and `rm`.
4. Every object goes to a new key, recorded in `upload_blobs` before the first byte is written:

| Object | Provider | Key |
| --- | --- | --- |
| Part `n` | temp | `<upload.fs.prefix>/<session id>/<n padded to 5 digits>-<uuid>`, e.g. `uploads/0f8f…/00003-6c1d…` |
| Merged file | files | `<fileDir(session)>/<uuid><ext>`, e.g. `uploads/files/9b2e….pdf`; `<ext>` is the lower-case extension of the name when it is 1 to 16 letters or digits, else nothing |

5. Removal is by recorded key, then the session folder `<prefix>/<session id>` as one `rm` when the sweeper purges a session.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `upload.fs.temp` | `string` | `'upload-temp'` | a `fs.providers` name | Provider of the parts. |
| `upload.fs.files` | `string` | `'upload-files'` | a `fs.providers` name | Provider of the merged files. |
| `upload.fs.prefix` | `string` | `'uploads'` | segments of `A-Z a-z 0-9 _ -` joined by `/` | First part of every part key and of the default file directory. |
| `upload.assembly.staleAfter` | `string` | `'30m'` | a duration above zero | Age after which the sweeper reclaims an object still being written and releases a stuck assembly. |

```ts
// config/fs.ts in your app: parts on local disk, files in S3
import '@spinajs/fs-s3';

export default {
  fs: {
    providers: [
      { service: 'fsNative', name: 'upload-temp', basePath: '/var/lib/app/upload-parts' },
      { service: 'fsS3', name: 'upload-files', bucket: 'acme-documents', createBucketIfNotExists: false },
    ],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UploadStorage` | `UploadStorage`, `@Singleton()`, `AsyncService` | `UploadStorage` | none | Not meant to be replaced: it holds the key layout and the blob bookkeeping. Pick providers with `upload.fs.*` or `fsFor()`. |
| Temp and files providers | `fs` providers by name (`@spinajs/fs`) | none: you define them | `fsNative`, `fsS3` (`@spinajs/fs-s3`), your own `fs` subclass | Any provider with `writeStream` (honouring `exclusive`), `readStream` and `rm`. See [Custom providers](../fs/06-custom-providers.md). |
| `FsMiddleware` | `Array.ofType(FsMiddleware)` (`@spinajs/fs`) | none | `AuthzFsMiddleware` (`@spinajs/authz-fs`) | Every upload call is a public file action, so every middleware runs on it. A middleware that refuses one refuses the upload. |

## Important behaviour

- **Never wrap the temp provider in an `fsTemp` with cleanup on.** Its strategy removes first-level entries by creation time (modified time when the provider reports none), not by activity, so it deletes the parts of sessions still being uploaded. The [sweeper](11-sweeper.md) owns cleanup of upload objects.
- **No listing, no rename.** The upload never calls `list`, `append`, `rename`, `move` or `mkdir`: rename and move are copy plus delete on S3, and `list` returns names on `fsNative` but full keys on S3. Cleanup reads `upload_blobs` instead.
- **Exclusive writes create their parent directories** on `fsNative`, so no `mkdir` is needed for the nested part keys.
- **Exclusive is only as strong as the backend.** `fsNative` opens with `wx`, which is atomic. `fsS3` sends `IfNoneMatch: '*'`; AWS S3 refuses the second of two concurrent writes, but a backend that ignores the header, or does not enforce it between concurrent multipart uploads (LocalStack 3.8.1), lets both succeed (a known limit, not fixed by the upload). The upload's keys are unique, so this never matters for its own writes; it matters only if something else writes under the same prefix.
- **S3 objects carry metadata.** A part stores `hash` (the declared hex SHA-256) as user metadata only when a digest was declared; part digests can be optional. The merged file stores the declared file digest, absent when none was declared, and its content type (detected, else declared, else `application/octet-stream`). `fsS3.hash()` returns a stored `hash` without reading the object, and streams the object when there is none.
- **The session folder goes in one `rm`.** On S3 that needs the prefix removal of `@spinajs/fs-s3` (`rm('a')` also deletes `a/…`). Every object was removed by key first, so a provider whose `rm` removes one key leaves nothing behind on S3 and only empty folders on disk.
- **authz-fs drops ACL rows with a prefix `rm`.** On a filesystem under `@spinajs/authz-fs`, an S3 prefix `rm` deletes the keys under the prefix and their `fs_acl` rows.
- **The merged file can sit under the session folder.** If your `fileDir()` puts it under `<prefix>/<session id>/`, the sweeper does not remove that folder when it purges a completed session.
- **`fileDir()` must not contain a `..` segment.** The write throws `InvalidOption`, answered `500` `upload.internal`; a backslash counts as a separator.
- **`staleAfter` must exceed the slowest part transfer and the slowest assembly.** The [sweeper](11-sweeper.md) reclaims an object still being written once it is older than `staleAfter`. The upload then answers `409` `upload.part_lost` or `upload.file_lost`, and the client retries.
- **A failed exclusive open cleans up.** When creating the stream throws after the `wx` open succeeded, `fsNative` closes the handle, removes the file and throws `IOFail`. A failure while bytes stream is discarded by `UploadStorage`; a partial object it cannot remove stays recorded as garbage for the sweeper. `fsS3` wraps S3 errors of `rm` in `IOFail`.
- **Unknown providers fail at boot or at create.** `upload.fs.*` are checked when `UploadStorage` resolves; a name from `fsFor()` is checked at create and throws `InvalidConfiguration` (`500`).

## Best practices

- Put the temp provider on fast local disk near the app: every part is written once and read once at assembly.
- Give the files provider its own bucket or directory, and serve downloads from there with your own routes or signed URLs.
- Keep upload providers out of `@spinajs/authz-fs` enforcement, or grant the upload's writes, reads and deletes there; otherwise uploads fail with `AccessDenied`.
- With several app nodes, the temp provider must be shared storage (or S3): a part written on one node is read by whichever node runs complete.

## Patterns and antipatterns

```ts
// Don't: fsTemp cleanup deletes the parts of uploads still in progress
{ service: 'fsTemp', name: 'upload-temp', provider: 'upload-temp-disk', cleanup: true, maxFileAge: 3600 }

// Do: a plain provider; the upload sweeper removes what the upload leaves
{ service: 'fsNative', name: 'upload-temp', basePath: '/var/lib/app/upload-parts' }
```

## Related

- [File operations](../fs/02-file-operations.md): `writeStream` options and exclusive writes.
- [S3 file provider](../fs-s3/01-s3-file-provider.md): conditional writes and prefix removal on S3.
- [Integrity](03-integrity.md#blob-tracking): the blob states.
