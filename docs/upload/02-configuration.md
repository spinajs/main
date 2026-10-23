# Configuration

Every `upload.*` key, with its default. The defaults live in the `upload` JSON schema, which the configuration fills in and validates at boot, so a wrong value stops the app before it serves a request.

## How it works

1. `UploadConfigBootstrapper` registers `UPLOAD_CONFIGURATION_SCHEMA` (`$id` `spinajs/upload.configuration.schema.json`) for the `upload` module. The sweeper module registers it at import too, so the scheduler subpath and the `upload:sweep` command get the defaults even when they load after the configuration.
2. The configuration validates the merged `upload` tree against it, fills every missing key with its default and refuses a wrong value.
3. The package's own config file adds three things: `system.dirs.cli` (the `upload:sweep` command), `db.Aliases.upload: 'default'`, and a `queue` route for every upload event to a black-hole connection.
4. `UploadStorage` checks at resolve that `upload.fs.temp` and `upload.fs.files` name providers of `fs.providers`. A missing one throws `InvalidConfiguration`: `upload: file provider(s) <names> are not defined in fs.providers`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `upload.fs.temp` | `string` | `'upload-temp'` | a `fs.providers` name | Provider of the parts. |
| `upload.fs.files` | `string` | `'upload-files'` | a `fs.providers` name | Provider of the merged files. May be the same provider as `temp`. |
| `upload.fs.prefix` | `string` | `'uploads'` | segments of `A-Z a-z 0-9 _ -` joined by `/` | First segment of every part key, and of the default file directory `<prefix>/files`. |
| `upload.limits.maxFileSize` | `integer` | `1073741824` (1 GiB) | `>= 1` | Largest `size` a session may declare. |
| `upload.limits.partSize` | `integer` | `8388608` (8 MiB) | `>= 1` | Part size when the client asks for none; clamped into `minPartSize`..`maxPartSize`. |
| `upload.limits.minPartSize` | `integer` | `1048576` (1 MiB) | `>= 1` | Smallest part size a client may ask for. |
| `upload.limits.maxPartSize` | `integer` | `67108864` (64 MiB) | `1`..`5368709120` (5 GiB, `UPLOAD_MAX_PART_BYTES`) | Largest part size; also the drain bound of a refused part whose size is unknown. |
| `upload.limits.maxParts` | `integer` | `10000` | `>= 1` | Most parts per session. |
| `upload.limits.maxOpenSessionsPerOwner` | `integer` | `20` | `>= 1` | Open sessions one owner may hold. Ignored for sessions without an owner. |
| `upload.limits.sessionTtl` | `string` | `'24h'` | a duration above zero: a number and `ms`, `s`, `m`, `h`, `d` or `w` | `expiresAt = createdAt + sessionTtl`. |
| `upload.integrity.partDigest` | `string` | `'required'` | `'required'`, `'optional'` | Whether a part needs a `sha-256` `Content-Digest`. |
| `upload.integrity.fileDigest` | `string` | `'required'` | `'required'`, `'optional'` | Whether complete needs the file's SHA-256, from create or from the complete body. |
| `upload.detect.headBytes` | `integer` | `4100` | `1`..`65536` | Bytes of part 1 the content check reads. Held in memory for each part-1 request. |
| `upload.detect.allowUndetected` | `string[]` | `['text/plain', 'text/csv']` | MIME types | Declared types accepted when no detector recognises the content. |
| `upload.assembly.staleAfter` | `string` | `'30m'` | a duration above zero | Age after which an assembly claim, or a blob still being written, counts as abandoned. Also the grace before the sweeper re-emits an owed final event. Must exceed the slowest part transfer and assembly you expect. |
| `upload.sweeper.every` | `string` | `'15m'` | a duration above zero | Interval of the `upload.sweep` schedule. |
| `upload.sweeper.retainFinished` | `string` | `'7d'` | a duration | Age, counted from the last update and once the final event was delivered, after which the sweeper purges a finished session. A completed session loses its parts; its row and file stay. A failed, aborted or expired session is deleted. |
| `upload.sweeper.batch` | `integer` | `200` | `>= 1` | Rows the sweeper reads per query. |
| `db.Aliases.upload` | `string` | `'default'` | a connection name | Connection of the upload tables and the migration. See [Database](12-database.md). |
| `queue.routing.<UploadEvent>.connection` | `string` | `'upload-events'` | a `queue.connections` name | Where each upload event goes. See [Events](09-events.md). |

`fs.providers` has no upload defaults: the storage engine is your choice. Define both providers yourself; see [Storage providers](07-storage-providers.md).

```ts
// config/upload.ts in your app
export default {
  fs: {
    providers: [
      { service: 'fsNative', name: 'upload-parts', basePath: '/var/lib/app/upload-parts' },
      { service: 'fsS3', name: 'documents', bucket: 'acme-documents', createBucketIfNotExists: false },
    ],
  },
  upload: {
    fs: { temp: 'upload-parts', files: 'documents', prefix: 'uploads' },
    limits: { maxFileSize: 5 * 1024 ** 3, partSize: 16 * 1024 ** 2, maxOpenSessionsPerOwner: 5, sessionTtl: '12h' },
    sweeper: { retainFinished: '3d' },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UploadConfigBootstrapper` | `Bootstrapper` list, run before the configuration resolves | registers `UPLOAD_CONFIGURATION_SCHEMA` | none | Not meant to be replaced. Read the schema object from `UPLOAD_CONFIGURATION_SCHEMA` to build your own checks. |

| Export | Effect |
| --- | --- |
| `parseDuration(value, field?)` | Turns a duration string into milliseconds. Throws `InvalidOption` for anything else. |
| `parsePositiveDuration(value, field?)` | The same for a duration above zero; a value that rounds below 1 ms counts as 1 ms. Throws `InvalidOption` for zero. |
| `DURATION_PATTERN` | The pattern the schema uses for `retainFinished`. |
| `POSITIVE_DURATION_PATTERN` | The pattern for `staleAfter`, `sessionTtl` and `every`. It refuses `0s` and `0.0h`. |

## Important behaviour

- **Package config merges first.** Your `db.Aliases.upload` and `queue.routing` entries replace the shipped ones.
- **Arrays concatenate across config files.** That is why the defaults live in the schema: an `allowUndetected` list in the package's config file would be added to yours, not replaced by it.
- **A controller can only tighten limits.** `limitsFor()` may lower `maxFileSize`, `maxPartSize`, `maxParts`, `maxOpenSessionsPerOwner` and `sessionTtl` and raise `minPartSize`; it may set `partSize` freely. A non-finite value in any other limit is ignored; a non-finite `partSize` is not, and answers `400` `upload.part_size`. A `sessionTtl` of zero is server misconfiguration and answers `500` `upload.internal`. See [Limits](06-limits.md).
- **Providers are fixed per session.** A session keeps the provider names it was created with, so changing `upload.fs.*` never strands an open session.
- **`maxPartSize` cannot exceed 5 GiB.** The part route's `@RequestStream({ maxBytes })` is fixed when the class is declared, at `UPLOAD_MAX_PART_BYTES`, so the schema caps the setting at the same value.

## Best practices

- Size `upload.assembly.staleAfter` above the longest part upload and the longest assembly you expect. The sweeper reclaims a write that outlives it, and the client gets `upload.part_lost` or `upload.file_lost`.
- Keep `upload.fs.prefix` stable. Every object is removed by its recorded key, but the final removal of a session folder uses the prefix of the current config, so a renamed prefix leaves the old, empty session folders on `fsNative`.

## Related

- [Limits](06-limits.md): what each limit refuses, and the HTTP limits that sit in front of them.
- [Sweeper](11-sweeper.md): `upload.sweeper.*` and `upload.assembly.staleAfter` in use.
- [Schema validation](../configuration/06-schema-validation.md): how module schemas fill defaults.
